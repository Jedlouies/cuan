import { useState, useRef, useEffect, useCallback } from 'react';
import { useDragToPan } from '../../hooks/useDragToPan';
import {
  Plus,
  Trash2,
  Printer,
  Database,
  Save,
  Eye,
  Pencil,
  X,
  Download,
} from 'lucide-react';
import { PageTabs } from '../../components/ui/PageTabs';
import { SaveConfirmModal } from '../../components/ui/SaveConfirmModal';
import {
  StatusDialog,
  StatusDialogState,
  INITIAL_STATUS_DIALOG,
} from '../../components/ui/StatusDialog';
import { useEnterToSave } from '../../hooks/useEnterToSave';
import {
  supabase,
  checkSupabaseConnected,
  ensureSupabaseConnected,
} from '../../lib/supabaseConnection';

/** Selects a clean whitespace band for page slicing so text lines are not cut in half. */
function findSafePageCutForPreview(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D | null,
  startY: number,
  pageHeightPx: number
): number {
  const targetY = Math.min(startY + pageHeightPx, canvas.height);
  if (targetY >= canvas.height || !context) return targetY;
  const searchStart = Math.max(startY + Math.floor(pageHeightPx * 0.55), startY + 1);
  const sampleStep = 5;
  const maxInkSamples = Math.max(24, Math.ceil(((canvas.width - 4) / sampleStep) * 0.12));
  let blankRunStart = -1;
  let bestCut = targetY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = searchStart; row < targetY - 1; row += 1) {
    let pixels: Uint8ClampedArray;
    try {
      pixels = context.getImageData(0, row, canvas.width, 1).data;
    } catch {
      // A cross-origin image can taint the canvas; fall back to the original page boundary.
      return targetY;
    }
    let inkSamples = 0;
    for (let x = 2; x < canvas.width - 2; x += sampleStep) {
      const offset = x * 4;
      if (pixels[offset] < 238 || pixels[offset + 1] < 238 || pixels[offset + 2] < 238) {
        inkSamples += 1;
        if (inkSamples > maxInkSamples) break;
      }
    }
    const isWhitespaceRow = inkSamples <= maxInkSamples;
    if (isWhitespaceRow && blankRunStart < 0) blankRunStart = row;
    if (!isWhitespaceRow && blankRunStart >= 0) {
      const runEnd = row - 1;
      if (runEnd - blankRunStart + 1 >= 4) {
        const candidate = Math.floor((blankRunStart + runEnd) / 2);
        const distance = targetY - candidate;
        if (distance < bestDistance) { bestDistance = distance; bestCut = candidate; }
      }
      blankRunStart = -1;
    }
  }
  if (blankRunStart >= 0 && targetY - 2 - blankRunStart + 1 >= 4) {
    const candidate = Math.floor((blankRunStart + targetY - 2) / 2);
    if (targetY - candidate < bestDistance) bestCut = candidate;
  }
  return bestCut;
}

type ProcurementTabKey = 'pr' | 'rfq' | 'abstract' | 'po' | 'iar';
type PaperSizeKey = 'a4' | 'letter' | 'legal';
type PaperOrientation = 'portrait' | 'landscape';
type ProcurementSupabaseTable =
  | 'purchase_request'
  | 'request_for_quotation'
  | 'abstract_of_quotation'
  | 'purchase_order'
  | 'inspection_and_acceptance';

interface LineItem {
  id: string;
  itemNo: string;
  qty: number;
  unit: string;
  description: string;
  unitCost: number;
}

interface PurchaseRequestRecord {
  prNo: string;
  date: string;
  purpose: string;
  requestedBy: string;
  requestedRole: string;
  items: LineItem[];
}

interface RfqItem {
  id: string;
  itemNo: string;
  qty: number;
  unit: string;
  description: string;
}

interface AbstractRow {
  id: string;
  itemNo: string;
  qty: number;
  unit: string;
  description: string;
  bid1: number;
  bid2: number;
  bid3: number;
}

interface IarItem {
  id: string;
  unit: string;
  description: string;
  qty: number;
}

interface ProcurementPayload {
  activeTab: ProcurementTabKey;
  paperSize?: PaperSizeKey;
  orientation?: PaperOrientation;
  createdBy?: string;
  prFormNo: string;
  prFormDate: string;
  prPurpose: string;
  prRequestedBy: string;
  prRequestedRole: string;
  prItems: LineItem[];
  rfqPrNo: string;
  rfqDate: string;
  rfqDealer: string;
  rfqAddress: string;
  rfqProposal: string;
  rfqBacChair: string;
  rfqFod: string;
  rfqDeliveryWillBe: string;
  rfqFob: string;
  rfqGoodItemsUnitYear: string;
  rfqItems: RfqItem[];
  absProposal: string;
  absPrNo: string;
  absDated: string;
  absOpened: string;
  absEntity1: string;
  absEntity2: string;
  absEntity3: string;
  absWinner: string;
  absRows: AbstractRow[];
  poNumber: string;
  poDate: string;
  poSupplier: string;
  poAddress: string;
  poTin: string;
  poMode: 'Shopping' | 'Negotiated' | 'Over the Counter';
  poDeliveryPlace: string;
  poDeliveryDate: string;
  poDeliveryTerm: string;
  poPaymentTerm: string;
  poConforme: string;
  poBudgetOfficer: string;
  poItems: LineItem[];
  iarSupplier: string;
  iarAddress: string;
  iarPoNo: string;
  iarInvoiceNo: string;
  iarInvoiceDate: string;
  iarAirNo: string;
  iarAirDate: string;
  iarRisNo: string;
  iarRisDate: string;
  iarDateInspected: string;
  iarDateReceived: string;
  iarStatus: 'Complete' | 'Partial';
  iarTreasurer: string;
  iarInspector: string;
  iarItems: IarItem[];
}

export interface ProcurementDbRecord {
  id: string;
  finalId: string;
  tableName: ProcurementSupabaseTable;
  docType: ProcurementTabKey;
  title: string;
  dateText: string;
  updatedAt: string;
  payload: ProcurementPayload;
}

interface FloatingInputState {
  visible: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
  type: 'text' | 'number';
  value: string | number;
  align: 'left' | 'right';
  onCommit: (nextVal: string) => void;
}

const AUTOSAVE_STORAGE_PREFIX = 'sk_procurement_autosave_v2';

const BASIC_UNITS = [
  'Pax',
  'Piece',
  'Pc',
  'Box',
  'Pack',
  'Set',
  'Bottle',
  'Ream',
  'Kilogram',
  'Gram',
  'Liter',
  'Roll',
  'Bundle',
  'Unit',
  'Lot',
];

const PAPER_DIMENSIONS: Record<
  PaperSizeKey,
  { label: string; widthMm: number; heightMm: number; cssSize: string }
> = {
  a4: {
    label: 'A4 (210 × 297 mm)',
    widthMm: 210,
    heightMm: 297,
    cssSize: 'A4',
  },
  letter: {
    label: 'Short / Letter (8.5 × 11 in)',
    widthMm: 215.9,
    heightMm: 279.4,
    cssSize: 'letter',
  },
  legal: {
    label: 'Long / Legal (8.5 × 14 in)',
    widthMm: 215.9,
    heightMm: 355.6,
    cssSize: 'legal',
  },
};

const TABS: {
  key: ProcurementTabKey;
  label: string;
  description: string;
  tableName: ProcurementSupabaseTable;
}[] = [
  {
    key: 'pr',
    label: 'Purchase Request',
    description:
      'Standalone Purchase Request template for SK Barangay Kauswagan.',
    tableName: 'purchase_request',
  },
  {
    key: 'rfq',
    label: 'Request for Quotation',
    description:
      'Standalone Request for Quotation template for prospective dealers.',
    tableName: 'request_for_quotation',
  },
  {
    key: 'abstract',
    label: 'Abstract of Quotation',
    description:
      'Standalone Abstract of Quotation template with 3 bidder columns.',
    tableName: 'abstract_of_quotation',
  },
  {
    key: 'po',
    label: 'Purchase Order',
    description:
      'Standalone Purchase Order template with terms and signatories.',
    tableName: 'purchase_order',
  },
  {
    key: 'iar',
    label: 'Inspection & Acceptance',
    description:
      'Standalone Inspection and Acceptance Report template.',
    tableName: 'inspection_and_acceptance',
  },
];

const PREPARED_BY_OPTIONS: { name: string; role: string }[] = [
  { name: 'HON. EFREN F. CORPUZ', role: 'Requesting Officer' },
  { name: 'HON. MARY JULLIAN DEL PUERTO', role: 'SK BAC Chairperson' },
  { name: 'HON. ELRISH JOHN L. DAAYATA', role: 'SK BAC Vice-Chairperson' },
  { name: 'MR. ALVIN GABRIEL B. CAHOY', role: 'SK BAC Secretariat' },
  { name: 'HON. SHANNEN KATE M. RAMOS', role: 'SK Kagawad' },
  { name: 'HON. RUCHELLE KYLE B. BAAL', role: 'SK Kagawad' },
  { name: 'HON. DHAR KENZOE B. OBSIOMA', role: 'SK Kagawad' },
  { name: 'HON. ABIJAH MIGUEL C. PACANA', role: 'SK Kagawad' },
  { name: 'HON. JAN MACKENXIE B. NAVARRO', role: 'SK Treasurer' },
];

const FIXED_SK_CHAIRPERSON = 'HON. RANCE EMIL D. ACHACOSO';
const FIXED_ABS_FORWARDED = 'HON. RANCE EMIL D. ACHACOSO';
const FIXED_ABS_ACTION = 'HON. RANCE EMIL D. ACHACOSO';
const FIXED_ABS_BAC_CHAIR = 'HON. MARY JULLIAN DEL PUERTO';
const FIXED_ABS_BAC_VICE_CHAIR = 'HON. ELRISH JOHN L. DAAYATA';
const FIXED_ABS_BAC_SEC = 'MR. ALVIN GABRIEL B. CAHOY';
const FIXED_ABS_MEM_1 = 'EFREN F. CORPUZ';
const FIXED_ABS_MEM_2 = 'HON. SHANNEN KATE M. RAMOS';
const FIXED_ABS_MEM_3 = 'HON. RUCHELLE KYLE B. BAAL';
const FIXED_ABS_MEM_4 = 'HON. DHAR KENZOE B. OBSIOMA';
const FIXED_ABS_MEM_5 = 'HON. ABIJAH MIGUEL C. PACANA';
const FIXED_PO_BUDGET_OFFICER = 'ABIJAH MIGUEL C. PACANA';
const FIXED_IAR_TREASURER = 'JAN MACKENXIE B. NAVARRO';
const FIXED_IAR_INSPECTOR = 'HON. ELRISH JOHN L. DAAYATA';

const ONES_WORDS = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
];
const TEENS_WORDS = [
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS_WORDS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function chunkToWords(num: number): string {
  let out = '';
  if (num >= 100) {
    out += `${ONES_WORDS[Math.floor(num / 100)]} Hundred `;
    num %= 100;
  }
  if (num >= 10 && num <= 19) {
    out += `${TEENS_WORDS[num - 10]} `;
  } else if (num >= 20) {
    out += `${TENS_WORDS[Math.floor(num / 10)]} `;
    num %= 10;
  }
  if (num >= 1 && num <= 9) {
    out += `${ONES_WORDS[num]} `;
  }
  return out.trim();
}

function amountToPesoWords(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const rounded = Math.round(amount * 100) / 100;
  let whole = Math.floor(rounded);
  const centavos = Math.round((rounded - whole) * 100);
  const scales = ['', 'Thousand', 'Million', 'Billion'];
  const parts: string[] = [];
  let idx = 0;

  while (whole > 0 && idx < scales.length) {
    const chunk = whole % 1000;
    if (chunk > 0) {
      const words = chunkToWords(chunk);
      parts.unshift(scales[idx] ? `${words} ${scales[idx]}` : words);
    }
    whole = Math.floor(whole / 1000);
    idx += 1;
  }

  const pesoLabel = `${parts.join(' ')} ${
    Math.floor(rounded) === 1 ? 'Peso' : 'Pesos'
  }`;
  return centavos > 0 ? `${pesoLabel} and ${centavos}/100` : pesoLabel;
}

const formatNumber = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function formatAutoDashDate(raw: string): string {
  const digitsOnly = raw.replace(/\D/g, '').slice(0, 8);
  if (digitsOnly.length <= 4) return digitsOnly;
  if (digitsOnly.length <= 6) {
    return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4)}`;
  }
  return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6)}`;
}

function generateUniqueDocNumber(existingNumbers: Iterable<string>): string {
  const used = new Set(existingNumbers);
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `${year}-${month}-`;

  let counter = 1;
  let candidate = `${prefix}${String(counter).padStart(3, '0')}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${prefix}${String(counter).padStart(3, '0')}`;
  }
  return candidate;
}

function sanitizeFileSegment(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Document'
  );
}

function isOfflineNow(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine;
}

export function ProcurementPage() {
  const [currentUserId, setCurrentUserId] = useState<string>('anonymous');
  const [isUserResolved, setIsUserResolved] = useState<boolean>(false);
  const restoredForUserRef = useRef<string | null>(null);

  const [activeTab, setActiveTab] = useState<ProcurementTabKey>('pr');
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('a4');
  const [orientation, setOrientation] = useState<PaperOrientation>('portrait');
  const [createdBy, setCreatedBy] = useState<string>('HON. EFREN F. CORPUZ');

  useEffect(() => {
    let active = true;

    const resolveLoggedInUser = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const user = session?.user;
        if (!active) return;

        setCurrentUserId(user?.id || 'anonymous');
        if (user) {
          const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
          const loggedUserName = String(
            meta.full_name ||
              meta.name ||
              meta.display_name ||
              user.email ||
              ''
          ).trim();

          if (loggedUserName) {
            setCreatedBy(loggedUserName);
          }
        }
      } catch {
        if (active) setCurrentUserId('anonymous');
      } finally {
        if (active) setIsUserResolved(true);
      }
    };

    void resolveLoggedInUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const user = session?.user;
      setCurrentUserId(user?.id || 'anonymous');
      setIsUserResolved(true);
      if (!user) return;
      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const loggedUserName = String(
        meta.full_name ||
          meta.name ||
          meta.display_name ||
          user.email ||
          ''
      ).trim();
      if (loggedUserName) {
        setCreatedBy(loggedUserName);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const getUserAutosaveKey = useCallback(
    () => `${AUTOSAVE_STORAGE_PREFIX}_${currentUserId}`,
    [currentUserId]
  );

  const [, setIsConnectingSupabase] = useState<boolean>(false);

  const [isDatabaseDialogOpen, setIsDatabaseDialogOpen] =
    useState<boolean>(false);
  const [viewingRecord, setViewingRecord] =
    useState<ProcurementDbRecord | null>(null);
  const [editingRecord, setEditingRecord] =
    useState<ProcurementDbRecord | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState<string>('');
  const [editDateDraft, setEditDateDraft] = useState<string>('');
  const [deletingRecord, setDeletingRecord] =
    useState<ProcurementDbRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const [statusDialog, setStatusDialog] = useState<StatusDialogState>(
    INITIAL_STATUS_DIALOG
  );

  const showStatus = useCallback(
    (
      type: StatusDialogState['type'],
      title: string,
      message: string,
      detail?: string,
      hideButtons = false
    ) => {
      setStatusDialog({
        open: true,
        type,
        title,
        message,
        detail,
        hideButtons: hideButtons || isOfflineNow(),
      });
    },
    []
  );

  const showNoInternetDialog = useCallback(() => {
    setStatusDialog({
      open: true,
      type: 'warning',
      title: 'No Internet Connection',
      message:
        'You are currently offline. Your changes are automatically saved locally for your user account.',
      hideButtons: true,
      isOffline: true,
    });
  }, []);

  const closeStatusDialog = () => {
    if (isOfflineNow()) return;
    setStatusDialog((prev) => ({ ...prev, open: false, hideButtons: false }));
  };

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const { panHandlers, isDragging: isDraggingPreview } = useDragToPan();
  const [previewPages, setPreviewPages] = useState<string[]>([]);
  const [previewPageIndex, setPreviewPageIndex] = useState<number>(0);
  const activePageIndex =
    previewPages.length > 0
      ? Math.min(Math.max(0, previewPageIndex), previewPages.length - 1)
      : 0;
  const [previewZoom, setPreviewZoom] = useState(100);
  const previewPanViewportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const viewport = previewPanViewportRef.current;
    if (!viewport) return;
    const frame = requestAnimationFrame(() => {
      viewport.scrollLeft = previewZoom > 100
        ? Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2)
        : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [previewZoom, previewPages.length]);

const zoomIn = () => {
  setPreviewZoom((prev) => Math.min(prev + 10, 200));
};

const zoomOut = () => {
  setPreviewZoom((prev) => Math.max(prev - 10, 50));
};

const resetZoom = () => setPreviewZoom(100);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [recordUuid, setRecordUuid] = useState<string>(() =>
    crypto.randomUUID()
  );
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null);
  const [, setFinalId] = useState<string>(() => generateUniqueDocNumber([]));
  const [dbRecords, setDbRecords] = useState<ProcurementDbRecord[]>([]);

  const [confirmSaveOpen, setConfirmSaveOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState<boolean>(false);

  const floatingRef = useRef<HTMLInputElement | null>(null);
  const [floatingInput, setFloatingInput] = useState<FloatingInputState>({
    visible: false,
    top: 0,
    left: 0,
    width: 180,
    height: 32,
    type: 'text',
    value: '',
    align: 'left',
    onCommit: () => {},
  });

  const openFloatingInput = (
    el: HTMLInputElement,
    type: 'text' | 'number',
    value: string | number,
    onCommit: (nextVal: string) => void,
    align: 'left' | 'right' = 'left'
  ) => {
    const rect = el.getBoundingClientRect();
    const expandedWidth = Math.max(rect.width + 80, 165);
    const maxLeft = Math.max(8, window.innerWidth - expandedWidth - 12);
    const clampedLeft = Math.min(Math.max(8, rect.left - 18), maxLeft);

    const displayValue =
      type === 'number' && (value === 0 || value === '0') ? '' : value;

    setFloatingInput({
      visible: true,
      top: rect.top - 4,
      left: clampedLeft,
      width: expandedWidth,
      height: Math.max(rect.height + 8, 32),
      type,
      value: displayValue,
      align,
      onCommit,
    });

    requestAnimationFrame(() => {
      floatingRef.current?.focus();
      floatingRef.current?.select();
    });
  };

  const closeFloatingInput = () => {
    setFloatingInput((prev) => ({ ...prev, visible: false }));
  };

  const [usedPrNumbers, setUsedPrNumbers] = useState<string[]>([]);
  const [usedPoNumbers, setUsedPoNumbers] = useState<string[]>([]);
  const [, setPrRecords] = useState<PurchaseRequestRecord[]>([]);

  // 1. Purchase Request
  const [prFormNo, setPrFormNo] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [prFormDate, setPrFormDate] = useState('2024-11-29');
  const [prPurpose, setPrPurpose] = useState('');
  const [prRequestedBy, setPrRequestedBy] = useState('HON. EFREN F. CORPUZ');
  const [prRequestedRole, setPrRequestedRole] = useState('Requesting Officer');
  const prApprovedBy = FIXED_SK_CHAIRPERSON;
  const [prItems, setPrItems] = useState<LineItem[]>([
    {
      id: 'pr-1',
      itemNo: '',
      qty: 0,
      unit: '',
      description: '',
      unitCost: 0,
    },
    {
      id: 'pr-2',
      itemNo: '',
      qty: 0,
      unit: '',
      description: '',
      unitCost: 0,
    },
    {
      id: 'pr-3',
      itemNo: '',
      qty: 0,
      unit: '',
      description: '',
      unitCost: 0,
    },
  ]);

  // 2. Request for Quotation
  const [rfqPrNo, setRfqPrNo] = useState<string>('2024-11-024');
  const [rfqDate, setRfqDate] = useState('');
  const [rfqDealer, setRfqDealer] = useState('');
  const [rfqAddress, setRfqAddress] = useState('');
  const [rfqProposal, setRfqProposal] = useState('CATERING SERVICES');
  const [rfqBacChair] = useState(FIXED_ABS_BAC_CHAIR);
  const [rfqFod, setRfqFod] = useState('');
  const [rfqDeliveryWillBe, setRfqDeliveryWillBe] = useState('');
  const [rfqFob, setRfqFob] = useState('');
  const [rfqGoodItemsUnitYear, setRfqGoodItemsUnitYear] = useState('');
  const [rfqItems, setRfqItems] = useState<RfqItem[]>([
    {
      id: 'rfq-1',
      itemNo: '1',
      qty: 0,
      unit: 'Pax',
      description: '',
    },
  ]);

  // 3. Abstract of Quotation
  const [absProposal, setAbsProposal] = useState('CATERING');
  const [absPrNo, setAbsPrNo] = useState('2024-11-024');
  const [absDated, setAbsDated] = useState('2024-12-04');
  const [absOpened, setAbsOpened] = useState('');
  const [absEntity1, setAbsEntity1] = useState('');
  const [absEntity2, setAbsEntity2] = useState('');
  const [absEntity3, setAbsEntity3] = useState('');
  const [absWinner, setAbsWinner] = useState(
    "ITEM NO. 1 SELWYN'S CATERING SERVICES"
  );
  const absForwardedBy = FIXED_ABS_FORWARDED;
  const absActionBy = FIXED_ABS_ACTION;
  const absBacChair = FIXED_ABS_BAC_CHAIR;
  const absBacViceChair = FIXED_ABS_BAC_VICE_CHAIR;
  const absBacSec = FIXED_ABS_BAC_SEC;
  const absMem1 = FIXED_ABS_MEM_1;
  const absMem2 = FIXED_ABS_MEM_2;
  const absMem3 = FIXED_ABS_MEM_3;
  const absMem4 = FIXED_ABS_MEM_4;
  const absMem5 = FIXED_ABS_MEM_5;
  const [absRows, setAbsRows] = useState<AbstractRow[]>([
    {
      id: 'abs-1',
      itemNo: '',
      qty: 0,
      unit: '',
      description: '',
      bid1: 0,
      bid2: 0,
      bid3: 0,
    },
    {
      id: 'abs-2',
      itemNo: '',
      qty: 0,
      unit: '',
      description: '',
      bid1: 0,
      bid2: 0,
      bid3: 0,
    },
    {
      id: 'abs-3',
      itemNo: '',
      qty: 0,
      unit: '',
      description: '',
      bid1: 0,
      bid2: 0,
      bid3: 0,
    },
  ]);

  // 4. Purchase Order
  const [poSupplier, setPoSupplier] = useState("Selwyn's Catering Services");
  const [poAddress, setPoAddress] = useState('D-4 Puntod, CDOC');
  const [poTin, setPoTin] = useState('648-297-215-00000');
  const [poNumber, setPoNumber] = useState<string>('2024-11-024');
  const [poDate, setPoDate] = useState('2024-12-10');
  const [poMode, setPoMode] = useState<
    'Shopping' | 'Negotiated' | 'Over the Counter'
  >('Shopping');
  const [poDeliveryPlace, setPoDeliveryPlace] = useState(
    'Barangay Hall Kauswagan'
  );
  const [poDeliveryDate, setPoDeliveryDate] = useState('November 2024');
  const [poDeliveryTerm, setPoDeliveryTerm] = useState('');
  const [poPaymentTerm, setPoPaymentTerm] = useState('');
  const poChair = FIXED_SK_CHAIRPERSON;
  const poChairRole = 'SK Chairperson';
  const [poConforme, setPoConforme] = useState("SELWYN'S CATERING SERVICES");
  const poBudgetOfficer = FIXED_PO_BUDGET_OFFICER;
  const [poItems, setPoItems] = useState<LineItem[]>([
    {
      id: 'po-1',
      itemNo: '1',
      qty: 0,
      unit: 'Pax',
      description: 'Catering',
      unitCost: 0,
    },
  ]);

  // 5. Inspection & Acceptance Report
  const [iarSupplier, setIarSupplier] = useState('');
  const [iarAddress, setIarAddress] = useState('');
  const [iarPoNo, setIarPoNo] = useState('');
  const [iarInvoiceNo, setIarInvoiceNo] = useState('');
  const [iarInvoiceDate, setIarInvoiceDate] = useState('');
  const [iarAirNo, setIarAirNo] = useState('');
  const [iarAirDate, setIarAirDate] = useState('');
  const [iarRisNo, setIarRisNo] = useState('');
  const [iarRisDate, setIarRisDate] = useState('');
  const [iarDateInspected, setIarDateInspected] = useState('');
  const [iarDateReceived, setIarDateReceived] = useState('');
  const [iarStatus, setIarStatus] = useState<'Complete' | 'Partial'>('Complete');
  const iarTreasurer = FIXED_IAR_TREASURER;
  const iarInspector = FIXED_IAR_INSPECTOR;
  const [iarItems, setIarItems] = useState<IarItem[]>([
    {
      id: 'iar-1',
      unit: '',
      description: '',
      qty: 0,
    },
  ]);

  const buildCurrentPayload = useCallback(
    (): ProcurementPayload => ({
      activeTab,
      paperSize,
      orientation,
      createdBy: (createdBy || prRequestedBy || 'HON. EFREN F. CORPUZ').trim(),
      prFormNo,
      prFormDate,
      prPurpose,
      prRequestedBy,
      prRequestedRole,
      prItems,
      rfqPrNo,
      rfqDate,
      rfqDealer,
      rfqAddress,
      rfqProposal,
      rfqBacChair,
      rfqFod,
      rfqDeliveryWillBe,
      rfqFob,
      rfqGoodItemsUnitYear,
      rfqItems,
      absProposal,
      absPrNo,
      absDated,
      absOpened,
      absEntity1,
      absEntity2,
      absEntity3,
      absWinner,
      absRows,
      poNumber,
      poDate,
      poSupplier,
      poAddress,
      poTin,
      poMode,
      poDeliveryPlace,
      poDeliveryDate,
      poDeliveryTerm,
      poPaymentTerm,
      poConforme,
      poBudgetOfficer,
      poItems,
      iarSupplier,
      iarAddress,
      iarPoNo,
      iarInvoiceNo,
      iarInvoiceDate,
      iarAirNo,
      iarAirDate,
      iarRisNo,
      iarRisDate,
      iarDateInspected,
      iarDateReceived,
      iarStatus,
      iarTreasurer,
      iarInspector,
      iarItems,
    }),
    [
      activeTab,
      paperSize,
      orientation,
      createdBy,
      prRequestedBy,
      prFormNo,
      prFormDate,
      prPurpose,
      prRequestedRole,
      prItems,
      rfqPrNo,
      rfqDate,
      rfqDealer,
      rfqAddress,
      rfqProposal,
      rfqBacChair,
      rfqFod,
      rfqDeliveryWillBe,
      rfqFob,
      rfqGoodItemsUnitYear,
      rfqItems,
      absProposal,
      absPrNo,
      absDated,
      absOpened,
      absEntity1,
      absEntity2,
      absEntity3,
      absWinner,
      absRows,
      poNumber,
      poDate,
      poSupplier,
      poAddress,
      poTin,
      poMode,
      poDeliveryPlace,
      poDeliveryDate,
      poDeliveryTerm,
      poPaymentTerm,
      poConforme,
      poBudgetOfficer,
      poItems,
      iarSupplier,
      iarAddress,
      iarPoNo,
      iarInvoiceNo,
      iarInvoiceDate,
      iarAirNo,
      iarAirDate,
      iarRisNo,
      iarRisDate,
      iarDateInspected,
      iarDateReceived,
      iarStatus,
      iarTreasurer,
      iarInspector,
      iarItems,
    ]
  );

  const writeAutosaveNow = useCallback(
    (
      overrideUuid?: string,
      overridePayload?: ProcurementPayload,
      overrideUpdatedAt?: string | null
    ) => {
      if (!isUserResolved) return;
      try {
        const snapshot = {
          id: overrideUuid ?? recordUuid,
          loadedUpdatedAt:
            overrideUpdatedAt !== undefined ? overrideUpdatedAt : loadedUpdatedAt,
          savedAt: new Date().toISOString(),
          payload: overridePayload ?? buildCurrentPayload(),
        };
        window.localStorage.setItem(
          getUserAutosaveKey(),
          JSON.stringify(snapshot)
        );
      } catch {
        // Ignore storage quota or restricted storage errors
      }
    },
    [
      buildCurrentPayload,
      getUserAutosaveKey,
      isUserResolved,
      loadedUpdatedAt,
      recordUuid,
    ]
  );

  const applyPayloadToEditor = useCallback(
    (
      p: Partial<ProcurementPayload>,
      overrideUuid?: string,
      overrideUpdatedAt?: string | null
    ) => {
      if (overrideUuid) setRecordUuid(overrideUuid);
      if (overrideUpdatedAt !== undefined) setLoadedUpdatedAt(overrideUpdatedAt);
      if (p.activeTab) setActiveTab(p.activeTab);
      if (p.paperSize) setPaperSize(p.paperSize);
      if (p.orientation) setOrientation(p.orientation);
      if (p.createdBy !== undefined) setCreatedBy(p.createdBy);
      if (p.prFormNo !== undefined) {
        setPrFormNo(p.prFormNo.trim() || generateUniqueDocNumber([]));
      }
      if (p.prFormDate !== undefined) setPrFormDate(p.prFormDate);
      if (p.prPurpose !== undefined) setPrPurpose(p.prPurpose);
      if (p.prRequestedBy !== undefined) setPrRequestedBy(p.prRequestedBy);
      if (p.prRequestedRole !== undefined) setPrRequestedRole(p.prRequestedRole);
      if (Array.isArray(p.prItems)) setPrItems(p.prItems);
      if (p.rfqPrNo !== undefined) setRfqPrNo(p.rfqPrNo);
      if (p.rfqDate !== undefined) setRfqDate(p.rfqDate);
      if (p.rfqDealer !== undefined) setRfqDealer(p.rfqDealer);
      if (p.rfqAddress !== undefined) setRfqAddress(p.rfqAddress);
      if (p.rfqProposal !== undefined) setRfqProposal(p.rfqProposal);
      if (p.rfqFod !== undefined) setRfqFod(p.rfqFod);
      if (p.rfqDeliveryWillBe !== undefined)
        setRfqDeliveryWillBe(p.rfqDeliveryWillBe);
      if (p.rfqFob !== undefined) setRfqFob(p.rfqFob);
      if (p.rfqGoodItemsUnitYear !== undefined)
        setRfqGoodItemsUnitYear(p.rfqGoodItemsUnitYear);
      if (Array.isArray(p.rfqItems)) setRfqItems(p.rfqItems);
      if (p.absProposal !== undefined) setAbsProposal(p.absProposal);
      if (p.absPrNo !== undefined) setAbsPrNo(p.absPrNo);
      if (p.absDated !== undefined) setAbsDated(p.absDated);
      if (p.absOpened !== undefined) setAbsOpened(p.absOpened);
      if (p.absEntity1 !== undefined) setAbsEntity1(p.absEntity1);
      if (p.absEntity2 !== undefined) setAbsEntity2(p.absEntity2);
      if (p.absEntity3 !== undefined) setAbsEntity3(p.absEntity3);
      if (p.absWinner !== undefined) setAbsWinner(p.absWinner);
      if (Array.isArray(p.absRows)) setAbsRows(p.absRows);
      if (p.poNumber !== undefined) setPoNumber(p.poNumber);
      if (p.poDate !== undefined) setPoDate(p.poDate);
      if (p.poSupplier !== undefined) setPoSupplier(p.poSupplier);
      if (p.poAddress !== undefined) setPoAddress(p.poAddress);
      if (p.poTin !== undefined) setPoTin(p.poTin);
      if (p.poMode !== undefined) setPoMode(p.poMode);
      if (p.poDeliveryPlace !== undefined)
        setPoDeliveryPlace(p.poDeliveryPlace);
      if (p.poDeliveryDate !== undefined) setPoDeliveryDate(p.poDeliveryDate);
      if (p.poDeliveryTerm !== undefined) setPoDeliveryTerm(p.poDeliveryTerm);
      if (p.poPaymentTerm !== undefined) setPoPaymentTerm(p.poPaymentTerm);
      if (p.poConforme !== undefined) setPoConforme(p.poConforme);
      if (Array.isArray(p.poItems)) setPoItems(p.poItems);
      if (p.iarSupplier !== undefined) setIarSupplier(p.iarSupplier);
      if (p.iarAddress !== undefined) setIarAddress(p.iarAddress);
      if (p.iarPoNo !== undefined) setIarPoNo(p.iarPoNo);
      if (p.iarInvoiceNo !== undefined) setIarInvoiceNo(p.iarInvoiceNo);
      if (p.iarInvoiceDate !== undefined) setIarInvoiceDate(p.iarInvoiceDate);
      if (p.iarAirNo !== undefined) setIarAirNo(p.iarAirNo);
      if (p.iarAirDate !== undefined) setIarAirDate(p.iarAirDate);
      if (p.iarRisNo !== undefined) setIarRisNo(p.iarRisNo);
      if (p.iarRisDate !== undefined) setIarRisDate(p.iarRisDate);
      if (p.iarDateInspected !== undefined)
        setIarDateInspected(p.iarDateInspected);
      if (p.iarDateReceived !== undefined)
        setIarDateReceived(p.iarDateReceived);
      if (p.iarStatus !== undefined) setIarStatus(p.iarStatus);
      if (Array.isArray(p.iarItems)) setIarItems(p.iarItems);
    },
    []
  );

  useEffect(() => {
    if (!isUserResolved) return;
    if (restoredForUserRef.current === currentUserId) return;
    restoredForUserRef.current = currentUserId;

    try {
      const raw = window.localStorage.getItem(getUserAutosaveKey());
      if (!raw) {
        setRecordUuid(crypto.randomUUID());
        setLoadedUpdatedAt(null);
        return;
      }
      const parsed = JSON.parse(raw) as {
        id?: string;
        loadedUpdatedAt?: string | null;
        payload?: Partial<ProcurementPayload>;
      };
      if (parsed?.payload) {
        applyPayloadToEditor(
          parsed.payload,
          parsed.id,
          parsed.loadedUpdatedAt ?? null
        );
      }
    } catch {
      // Ignore storage read errors
    }
  }, [applyPayloadToEditor, currentUserId, getUserAutosaveKey, isUserResolved]);

  useEffect(() => {
    if (!isUserResolved || restoredForUserRef.current !== currentUserId) return;
    writeAutosaveNow();

    const intervalId = window.setInterval(() => writeAutosaveNow(), 1000);
    const flush = () => writeAutosaveNow();

    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentUserId, isUserResolved, writeAutosaveNow]);

  const getCurrentRecordTitle = useCallback((): string => {
    if (activeTab === 'pr') return prPurpose || `PR ${prFormNo}`;
    if (activeTab === 'rfq') return rfqDealer || `RFQ ${rfqPrNo || 'Draft'}`;
    if (activeTab === 'abstract') return absProposal || `Abstract ${absPrNo}`;
    if (activeTab === 'po') return poSupplier || `PO ${poNumber}`;
    return iarSupplier || `IAR ${iarPoNo || 'Draft'}`;
  }, [
    activeTab,
    prPurpose,
    prFormNo,
    rfqDealer,
    rfqPrNo,
    absProposal,
    absPrNo,
    poSupplier,
    poNumber,
    iarSupplier,
    iarPoNo,
  ]);

  const hydrateFromDbRows = useCallback((rows: ProcurementDbRecord[]) => {
    if (rows.length === 0) return;

    const dbPrRecords = rows.filter(
      (r) => r.docType === 'pr' || r.tableName === 'purchase_request'
    );
    const dbPoRecords = rows.filter(
      (r) => r.docType === 'po' || r.tableName === 'purchase_order'
    );

    const dbPrNumbers = dbPrRecords
      .map((r) => r.finalId || r.payload?.prFormNo)
      .filter((v): v is string => Boolean(v));
    const dbPoNumbers = dbPoRecords
      .map((r) => r.finalId || r.payload?.poNumber)
      .filter((v): v is string => Boolean(v));

    setUsedPrNumbers(Array.from(new Set(dbPrNumbers)));
    setUsedPoNumbers(Array.from(new Set(dbPoNumbers)));

    const nextAvailablePr = generateUniqueDocNumber(dbPrNumbers);
    const nextAvailablePo = generateUniqueDocNumber(dbPoNumbers);

    setPrFormNo((curr) =>
      dbPrNumbers.includes(curr) ? nextAvailablePr : curr
    );
    setPoNumber((curr) =>
      dbPoNumbers.includes(curr) ? nextAvailablePo : curr
    );

    if (dbPrRecords.length > 0) {
      const latestPr = dbPrRecords[0];
      const latestPrNo = latestPr.finalId || latestPr.payload?.prFormNo || '';
      setRfqPrNo((curr) => {
        const chosenNo = dbPrNumbers.includes(curr) ? curr : latestPrNo;
        const chosenRec = dbPrRecords.find(
          (r) => (r.finalId || r.payload?.prFormNo) === chosenNo
        );
        if (chosenRec?.payload?.prItems) {
          setRfqItems(
            chosenRec.payload.prItems.map((item, idx) => ({
              id: `rfq-${item.id}-${idx}`,
              itemNo: item.itemNo || String(idx + 1),
              qty: item.qty,
              unit: item.unit || 'Pax',
              description: item.description,
            }))
          );
        }
        return chosenNo;
      });
    }

    if (dbPoRecords.length > 0) {
      const latestPo = dbPoRecords[0];
      const latestPoNo = latestPo.finalId || latestPo.payload?.poNumber || '';
      setIarPoNo((curr) => {
        const chosenPoNo = dbPoNumbers.includes(curr) ? curr : latestPoNo;
        const chosenPoRec = dbPoRecords.find(
          (r) => (r.finalId || r.payload?.poNumber) === chosenPoNo
        );
        if (chosenPoRec?.payload) {
          if (chosenPoRec.payload.poSupplier) {
            setIarSupplier(chosenPoRec.payload.poSupplier);
          }
          if (chosenPoRec.payload.poAddress) {
            setIarAddress(chosenPoRec.payload.poAddress);
          }
          if (chosenPoRec.payload.poItems) {
            setIarItems(
              chosenPoRec.payload.poItems.map((item, idx) => ({
                id: `iar-${item.id}-${idx}`,
                unit: item.unit || 'Pax',
                description: item.description,
                qty: item.qty,
              }))
            );
          }
        }
        return chosenPoNo;
      });
    }
  }, []);

  const loadProcurementRecordsFromSupabase = useCallback(
    async (silentIfOffline = false): Promise<ProcurementDbRecord[]> => {
      if (isOfflineNow()) {
        if (!silentIfOffline) {
          showNoInternetDialog();
        }
        return [];
      }

      const collected: ProcurementDbRecord[] = [];

      for (const tab of TABS) {
        const { data, error } = await supabase
          .from(tab.tableName as never)
          .select('*');

        if (error) {
          throw new Error(error.message);
        }

        const rows = (data ?? []) as Record<string, unknown>[];
        for (const row of rows) {
          const id = String(row.id ?? crypto.randomUUID());
          const savedPayload =
            typeof row.payload === 'object' && row.payload !== null
              ? (row.payload as Partial<ProcurementPayload>)
              : {};

          const prNo = String(row.pr_number ?? savedPayload.prFormNo ?? '');
          const poNo = String(row.po_number ?? savedPayload.poNumber ?? '');
          const finalDocId =
            tab.key === 'pr'
              ? prNo || id.slice(0, 8).toUpperCase()
              : tab.key === 'po'
              ? poNo || id.slice(0, 8).toUpperCase()
              : `${tab.key.toUpperCase()}-${id.slice(0, 8).toUpperCase()}`;

          const recTitle = String(
            row.purpose ??
              row.title ??
              row.supplier_name ??
              row.dealer_name ??
              savedPayload.prPurpose ??
              savedPayload.poSupplier ??
              savedPayload.absProposal ??
              `Untitled ${tab.label}`
          );

          const recDate = String(
            row.requested_date ??
              row.date ??
              row.invoice_date ??
              row.date_inspected ??
              savedPayload.prFormDate ??
              savedPayload.poDate ??
              ''
          );

          const payload: ProcurementPayload = {
            activeTab: tab.key,
            paperSize:
              (row.paper_size as PaperSizeKey) ||
              savedPayload.paperSize ||
              'a4',
            orientation:
              (row.orientation as PaperOrientation) ||
              savedPayload.orientation ||
              'portrait',
            createdBy: String(row.created_by ?? savedPayload.createdBy ?? ''),
            prFormNo: prNo || generateUniqueDocNumber([]),
            prFormDate: String(
              row.requested_date ?? savedPayload.prFormDate ?? '2024-11-29'
            ),
            prPurpose: String(row.purpose ?? savedPayload.prPurpose ?? ''),
            prRequestedBy: String(
              (typeof row.requested_by === 'object' && row.requested_by !== null
                ? (row.requested_by as { name?: string }).name
                : undefined) ??
                savedPayload.prRequestedBy ??
                'HON. EFREN F. CORPUZ'
            ),
            prRequestedRole: String(
              (typeof row.requested_by === 'object' && row.requested_by !== null
                ? (row.requested_by as { role?: string }).role
                : undefined) ??
                savedPayload.prRequestedRole ??
                'Requesting Officer'
            ),
            prItems:
              Array.isArray(row.items) && tab.key === 'pr'
                ? (row.items as LineItem[])
                : savedPayload.prItems ?? [],
            rfqPrNo: String(row.pr_number ?? savedPayload.rfqPrNo ?? ''),
            rfqDate: String(row.date ?? savedPayload.rfqDate ?? ''),
            rfqDealer: String(row.dealer_name ?? savedPayload.rfqDealer ?? ''),
            rfqAddress: String(
              row.dealer_address ?? savedPayload.rfqAddress ?? ''
            ),
            rfqProposal: String(
              row.proposal_quotation_title ??
                savedPayload.rfqProposal ??
                'CATERING SERVICES'
            ),
            rfqBacChair: String(
              row.bac_chairman_name ??
                savedPayload.rfqBacChair ??
                FIXED_ABS_BAC_CHAIR
            ),
            rfqFod: String(row.fob_destination ?? savedPayload.rfqFod ?? ''),
            rfqDeliveryWillBe: String(
              row.delivery_period ?? savedPayload.rfqDeliveryWillBe ?? ''
            ),
            rfqFob: String(row.fob_location ?? savedPayload.rfqFob ?? ''),
            rfqGoodItemsUnitYear: savedPayload.rfqGoodItemsUnitYear ?? '',
            rfqItems:
              Array.isArray(row.items) && tab.key === 'rfq'
                ? (row.items as RfqItem[])
                : savedPayload.rfqItems ?? [],
            absProposal: String(
              row.title ?? savedPayload.absProposal ?? 'CATERING'
            ),
            absPrNo: String(row.pr_number ?? savedPayload.absPrNo ?? ''),
            absDated: String(row.date ?? savedPayload.absDated ?? '2024-12-04'),
            absOpened: String(row.opened_at ?? savedPayload.absOpened ?? ''),
            absEntity1: String(
              Array.isArray(row.bidders)
                ? row.bidders[0] ?? ''
                : savedPayload.absEntity1 ?? ''
            ),
            absEntity2: String(
              Array.isArray(row.bidders)
                ? row.bidders[1] ?? ''
                : savedPayload.absEntity2 ?? ''
            ),
            absEntity3: String(
              Array.isArray(row.bidders)
                ? row.bidders[2] ?? ''
                : savedPayload.absEntity3 ?? ''
            ),
            absWinner: String(
              (typeof row.winning_bidder_name === 'object' &&
              row.winning_bidder_name !== null
                ? (row.winning_bidder_name as { label?: string }).label
                : undefined) ??
                savedPayload.absWinner ??
                "ITEM NO. 1 SELWYN'S CATERING SERVICES"
            ),
            absRows:
              Array.isArray(row.items) && tab.key === 'abstract'
                ? (row.items as AbstractRow[])
                : savedPayload.absRows ?? [],
            poNumber: poNo || '2024-11-024',
            poDate: String(row.date ?? savedPayload.poDate ?? '2024-12-10'),
            poSupplier: String(
              row.supplier_name ?? savedPayload.poSupplier ?? ''
            ),
            poAddress: String(
              row.supplier_address ?? savedPayload.poAddress ?? ''
            ),
            poTin: String(row.supplier_tin ?? savedPayload.poTin ?? ''),
            poMode:
              (row.mode_of_procurement as
                | 'Shopping'
                | 'Negotiated'
                | 'Over the Counter') ||
              savedPayload.poMode ||
              'Shopping',
            poDeliveryPlace: String(
              row.place_of_delivery ?? savedPayload.poDeliveryPlace ?? ''
            ),
            poDeliveryDate: String(
              row.date_of_delivery ?? savedPayload.poDeliveryDate ?? ''
            ),
            poDeliveryTerm: String(
              row.delivery_term ?? savedPayload.poDeliveryTerm ?? ''
            ),
            poPaymentTerm: String(
              row.payment_term ?? savedPayload.poPaymentTerm ?? ''
            ),
            poConforme: String(
              row.conforme_supplier_name ?? savedPayload.poConforme ?? ''
            ),
            poBudgetOfficer: String(
              row.budget_officer_name ??
                savedPayload.poBudgetOfficer ??
                FIXED_PO_BUDGET_OFFICER
            ),
            poItems:
              Array.isArray(row.items) && tab.key === 'po'
                ? (row.items as LineItem[])
                : savedPayload.poItems ?? [],
            iarSupplier: String(
              row.supplier_name ?? savedPayload.iarSupplier ?? ''
            ),
            iarAddress: String(
              row.supplier_address ?? savedPayload.iarAddress ?? ''
            ),
            iarPoNo: String(row.po_number ?? savedPayload.iarPoNo ?? ''),
            iarInvoiceNo: String(
              row.invoice_number ?? savedPayload.iarInvoiceNo ?? ''
            ),
            iarInvoiceDate: String(
              row.invoice_date ?? savedPayload.iarInvoiceDate ?? ''
            ),
            iarAirNo: String(row.air_number ?? savedPayload.iarAirNo ?? ''),
            iarAirDate: String(row.air_date ?? savedPayload.iarAirDate ?? ''),
            iarRisNo: String(
              row.cntrl_ris_number ?? savedPayload.iarRisNo ?? ''
            ),
            iarRisDate: String(
              row.cntrl_ris_date ?? savedPayload.iarRisDate ?? ''
            ),
            iarDateInspected: String(
              row.date_inspected ?? savedPayload.iarDateInspected ?? ''
            ),
            iarDateReceived: String(
              row.date_received ?? savedPayload.iarDateReceived ?? ''
            ),
            iarStatus:
              row.acceptance_status === 'partial' ||
              savedPayload.iarStatus === 'Partial'
                ? 'Partial'
                : 'Complete',
            iarTreasurer: String(
              row.inspector_name ??
                savedPayload.iarTreasurer ??
                FIXED_IAR_TREASURER
            ),
            iarInspector: String(
              row.inspection_officer_name ??
                savedPayload.iarInspector ??
                FIXED_IAR_INSPECTOR
            ),
            iarItems:
              Array.isArray(row.items) && tab.key === 'iar'
                ? (row.items as IarItem[])
                : savedPayload.iarItems ?? [],
          };

          collected.push({
            id,
            finalId: finalDocId,
            tableName: tab.tableName,
            docType: tab.key,
            title: recTitle,
            dateText: recDate,
            updatedAt: String(
              row.updated_at ?? row.created_at ?? new Date().toISOString()
            ),
            payload,
          });
        }
      }

      setDbRecords(collected);
      hydrateFromDbRows(collected);
      return collected;
    },
    [hydrateFromDbRows, showNoInternetDialog]
  );

  useEffect(() => {
    let active = true;

    const handleOffline = () => {
      if (!active) return;
      writeAutosaveNow();
      showNoInternetDialog();
    };

    const handleOnline = () => {
      if (!active) return;
      setStatusDialog((prev) =>
        prev.hideButtons ? { ...prev, open: false, hideButtons: false } : prev
      );
      void loadProcurementRecordsFromSupabase(true).catch(() => {});
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    if (isOfflineNow()) {
      showNoInternetDialog();
      return () => {
        active = false;
        window.removeEventListener('offline', handleOffline);
        window.removeEventListener('online', handleOnline);
      };
    }

    const initLoad = async () => {
      try {
        const connected = await checkSupabaseConnected();
        if (!active) return;
        if (!connected) {
          await ensureSupabaseConnected(setIsConnectingSupabase);
        }
        await loadProcurementRecordsFromSupabase(true);
      } catch {
        // Ignore offline errors
      }
    };

    void initLoad();

    const channel = supabase
      .channel('procurement-realtime-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'purchase_request' },
        () => {
          if (active) void loadProcurementRecordsFromSupabase(true).catch(() => {});
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'request_for_quotation' },
        () => {
          if (active) void loadProcurementRecordsFromSupabase(true).catch(() => {});
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'abstract_of_quotation' },
        () => {
          if (active) void loadProcurementRecordsFromSupabase(true).catch(() => {});
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'purchase_order' },
        () => {
          if (active) void loadProcurementRecordsFromSupabase(true).catch(() => {});
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inspection_and_acceptance' },
        () => {
          if (active) void loadProcurementRecordsFromSupabase(true).catch(() => {});
        }
      )
      .subscribe();

    return () => {
      active = false;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      void supabase.removeChannel(channel);
    };
  }, [loadProcurementRecordsFromSupabase, showNoInternetDialog, writeAutosaveNow]);

  const currentTabMeta = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  const filteredDbRecords = dbRecords.filter(
    (rec) =>
      rec.docType === activeTab || rec.tableName === currentTabMeta.tableName
  );

  const prTotal = prItems.reduce((sum, r) => sum + r.qty * r.unitCost, 0);
  const poTotal = poItems.reduce((sum, r) => sum + r.qty * r.unitCost, 0);
  const prApprovedRole = 'SK Chairperson';

  const savedDbPrRecords = dbRecords.filter(
    (rec) => rec.docType === 'pr' || rec.tableName === 'purchase_request'
  );
  const availableDbPrNumbers = Array.from(
    new Set(
      savedDbPrRecords
        .map((rec) => rec.finalId || rec.payload?.prFormNo)
        .filter((v): v is string => Boolean(v))
    )
  );

  const savedDbPoRecords = dbRecords.filter(
    (rec) => rec.docType === 'po' || rec.tableName === 'purchase_order'
  );
  const availableDbPoNumbers = Array.from(
    new Set([
      ...savedDbPoRecords
        .map((rec) => rec.finalId || rec.payload?.poNumber)
        .filter((v): v is string => Boolean(v)),
      ...usedPoNumbers,
      poNumber,
    ].filter((v): v is string => Boolean(v)))
  );

  const getDefaultFinalIdForCurrentTab = (): string => {
    if (activeTab === 'pr') return prFormNo;
    if (activeTab === 'po') return poNumber;
    if (activeTab === 'rfq')
      return rfqPrNo
        ? `RFQ-${rfqPrNo}`
        : `RFQ-${recordUuid.slice(0, 8).toUpperCase()}`;
    if (activeTab === 'abstract')
      return absPrNo
        ? `ABS-${absPrNo}`
        : `ABS-${recordUuid.slice(0, 8).toUpperCase()}`;
    return iarPoNo
      ? `IAR-${iarPoNo}`
      : `IAR-${recordUuid.slice(0, 8).toUpperCase()}`;
  };

  const paperSpec = PAPER_DIMENSIONS[paperSize];
  const pageWidthMm =
    orientation === 'portrait' ? paperSpec.widthMm : paperSpec.heightMm;
  const pageMinHeightMm =
    orientation === 'portrait' ? paperSpec.heightMm : paperSpec.widthMm;

  const currentPayloadSnapshot = buildCurrentPayload();

  useEffect(() => {
    const source = sheetRef.current;
    if (!source) return;

    let timer: ReturnType<typeof window.setTimeout> | undefined;
    let renderId = 0;
    let disposed = false;

    const renderPreview = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const thisRender = ++renderId;
        try {
          const { default: html2canvas } = await import('html2canvas-pro');

          const captureHost = document.createElement('div');
          const captureId = `sk-paper-capture-${activeTab}-${orientation}-${thisRender}`;
          captureHost.id = captureId;
          captureHost.style.position = 'fixed';
          captureHost.style.left = '0';
          captureHost.style.top = '0';
          captureHost.style.zIndex = '2147483000';
          captureHost.style.opacity = '0';
          captureHost.style.pointerEvents = 'none';
          captureHost.style.background = '#ffffff';
          captureHost.style.width = `${pageWidthMm}mm`;
          captureHost.style.maxWidth = `${pageWidthMm}mm`;
          captureHost.style.overflow = 'hidden';
          captureHost.style.boxSizing = 'border-box';
          captureHost.style.display = 'block';

          const captureClone = source.cloneNode(true) as HTMLElement;
          captureClone.style.position = 'static';
          captureClone.style.left = 'auto';
          captureClone.style.top = 'auto';
          captureClone.style.right = 'auto';
          captureClone.style.bottom = 'auto';
          captureClone.style.zIndex = 'auto';
          captureClone.style.margin = '0';
          captureClone.style.boxShadow = 'none';
          captureClone.style.transform = 'none';
          captureClone.style.visibility = 'visible';

          // Preview-only placeholders keep empty form fields and table cells
          // visibly structured without changing the saved payload.
          captureClone.querySelectorAll<HTMLElement>(
            'td, [class*="border-b"]'
          ).forEach((element) => {
            if (element.textContent?.trim() || element.children.length > 0) return;
            const placeholder = document.createElement('span');
            placeholder.textContent = '—';
            placeholder.style.color = '#94a3b8';
            placeholder.style.fontStyle = 'italic';
            placeholder.style.fontWeight = 'normal';
            element.appendChild(placeholder);
          });

          // Keep the SK header artwork and logos within the full paper width.
          captureClone.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            img.style.objectFit = 'contain';
            img.style.objectPosition = 'top center';
          });
          captureClone.style.boxSizing = 'border-box';
          captureClone.style.width = `${pageWidthMm}mm`;
          captureClone.style.minWidth = `${pageWidthMm}mm`;
          captureClone.style.maxWidth = `${pageWidthMm}mm`;
          captureClone.style.minHeight = `${pageMinHeightMm}mm`;
          captureClone.style.height = 'auto';
          captureClone.style.overflow = 'hidden';

          captureClone.querySelectorAll<HTMLElement>('*').forEach((node) => {
            node.style.boxSizing = 'border-box';
            node.style.maxWidth = '100%';
          });
          captureClone.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
            table.style.width = '100%';
            table.style.maxWidth = '100%';
            table.style.tableLayout = 'fixed';
          });
          captureClone.querySelectorAll<HTMLElement>('th, td').forEach((cell) => {
            cell.style.overflowWrap = 'anywhere';
            cell.style.wordBreak = 'break-word';
          });
          captureClone.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
          });

          captureClone.querySelectorAll<HTMLElement>('p, span, div, li, td, th').forEach((element) => {
            element.style.maxWidth = '100%';
            element.style.overflowWrap = 'anywhere';
            element.style.wordBreak = 'break-word';
          });
          captureHost.appendChild(captureClone);
          document.body.appendChild(captureHost);

          let canvas: HTMLCanvasElement;
          try {
            await (document.fonts?.ready ?? Promise.resolve());
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() =>
                window.requestAnimationFrame(() => resolve())
              );
            });

            const captureRect = captureClone.getBoundingClientRect();
            const captureWidth = Math.ceil(
              captureRect.width || captureClone.offsetWidth
            );
            const captureHeight = Math.ceil(
              Math.max(captureClone.scrollHeight, captureRect.height)
            );
            if (!captureWidth || !captureHeight) {
              throw new Error('The document page has no measurable size yet.');
            }

            canvas = await html2canvas(captureClone, {
              scale: Math.min(3, Math.max(2, window.devicePixelRatio || 2)),
              width: captureWidth,
              height: captureHeight,
              windowWidth: captureWidth,
              windowHeight: captureHeight,
              scrollX: 0,
              scrollY: 0,
              useCORS: true,
              backgroundColor: '#ffffff',
              logging: false,
              onclone: (clonedDocument) => {
                const host = clonedDocument.getElementById(captureId);
                if (host) {
                  host.style.opacity = '1';
                  host.style.zIndex = '2147483000';
                }
              },
            });
          } finally {
            captureHost.remove();
          }

          if (disposed || thisRender !== renderId || canvas.width === 0) return;
          setPreviewError(null);

          const pageHeightPx = Math.max(
            1,
            Math.round((canvas.width * pageMinHeightMm) / pageWidthMm)
          );
          const pages: string[] = [];
          const sourceContext = canvas.getContext('2d');
          let y = 0;

          while (y < canvas.height) {
            const targetY = Math.min(y + pageHeightPx, canvas.height);
            const cutY = findSafePageCutForPreview(canvas, sourceContext, y, pageHeightPx);

            const sliceHeight = Math.max(1, Math.min(cutY - y, pageHeightPx));
            const pageCanvas = document.createElement('canvas');
            pageCanvas.width = canvas.width;
            pageCanvas.height = pageHeightPx;
            const context = pageCanvas.getContext('2d');
            if (!context) break;
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
            context.drawImage(
              canvas,
              0,
              y,
              canvas.width,
              sliceHeight,
              0,
              0,
              canvas.width,
              sliceHeight
            );
            pages.push(pageCanvas.toDataURL('image/png'));
            y += sliceHeight;
          }

          if (!disposed && thisRender === renderId) {
            setPreviewPages(pages);
            setPreviewPageIndex(0);
          }
        } catch (error) {
          console.error('Could not create paginated paper preview:', error);
          if (!disposed && thisRender === renderId) {
            setPreviewError(
              error instanceof Error
                ? error.message
                : 'Could not render the page preview.'
            );
          }
        }
      }, 120);
    };

    const observer = new MutationObserver(renderPreview);
    observer.observe(source, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    source.addEventListener('input', renderPreview, true);
    source.addEventListener('change', renderPreview, true);
    renderPreview();

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      observer.disconnect();
      source.removeEventListener('input', renderPreview, true);
      source.removeEventListener('change', renderPreview, true);
    };
  }, [pageWidthMm, pageMinHeightMm, activeTab, orientation, currentPayloadSnapshot]);

  const handleDownloadPdf = async () => {
    const sheet = sheetRef.current;
    if (!sheet || isDownloadingPdf) return;

    closeStatusDialog();

    const docCode = getDefaultFinalIdForCurrentTab() || activeTab.toUpperCase();
    const fileName = `${activeTab.toUpperCase()}_${sanitizeFileSegment(
      docCode
    )}.pdf`;

    setIsDownloadingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas-pro'),
        import('jspdf'),
      ]);

      const clone = sheet.cloneNode(true) as HTMLElement;
      clone.style.boxShadow = 'none';
      clone.style.position = 'static';
      clone.style.left = 'auto';
      clone.style.top = 'auto';
      clone.style.zIndex = 'auto';
      clone.style.margin = '0';
      clone.style.width = `${pageWidthMm}mm`;
      clone.style.maxWidth = `${pageWidthMm}mm`;
      clone.style.overflow = 'hidden';
      clone.classList.remove('shadow-lg', 'ring-1', 'mx-auto');

      clone.querySelectorAll<HTMLElement>('*').forEach((node) => {
        node.style.boxSizing = 'border-box';
        node.style.maxWidth = '100%';
      });
      clone.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
        table.style.width = '100%';
        table.style.maxWidth = '100%';
        table.style.tableLayout = 'fixed';
      });

      const holder = document.createElement('div');
      holder.style.position = 'fixed';
      holder.style.left = '-10000px';
      holder.style.top = '0';
      holder.style.width = `${pageWidthMm}mm`;
      holder.style.overflow = 'hidden';
      holder.appendChild(clone);
      document.body.appendChild(holder);

      let canvas: HTMLCanvasElement;
      try {
        canvas = await html2canvas(clone, {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          width: clone.scrollWidth,
          height: clone.scrollHeight,
          windowWidth: clone.scrollWidth,
          windowHeight: clone.scrollHeight,
        });
      } finally {
        document.body.removeChild(holder);
      }

      const pdf = new jsPDF({
        unit: 'mm',
        format: [pageWidthMm, pageMinHeightMm],
        orientation,
      });

      const pxPerMm = canvas.width / pageWidthMm;
      const pageHeightPx = Math.floor(pageMinHeightMm * pxPerMm);
      const sourceContext = canvas.getContext('2d');
      let y = 0;
      let page = 0;

      while (y < canvas.height) {
        const cutY = findSafePageCutForPreview(canvas, sourceContext, y, pageHeightPx);
        const sliceH = Math.max(1, Math.min(cutY - y, pageHeightPx, canvas.height - y));
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = pageHeightPx;
        const ctx = pageCanvas.getContext('2d');
        if (!ctx) throw new Error('Canvas not supported.');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(
          canvas,
          0,
          y,
          canvas.width,
          sliceH,
          0,
          0,
          canvas.width,
          sliceH
        );

        if (page > 0) pdf.addPage();
        pdf.addImage(
          pageCanvas.toDataURL('image/jpeg', 0.98),
          'JPEG',
          0,
          0,
          pageWidthMm,
          pageMinHeightMm
        );

        y += sliceH;
        page += 1;
      }

      pdf.save(fileName);
      showStatus(
        'success',
        'PDF Downloaded',
        `"${fileName}" was generated and sent to your browser downloads.`
      );
    } catch (err) {
      showStatus(
        'error',
        'Download Failed',
        'Unable to generate the PDF.',
        err instanceof Error ? err.message : 'Please try again.'
      );
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  const handlePrint = () => {
    closeStatusDialog();

    const onAfterPrint = () => {
      window.removeEventListener('afterprint', onAfterPrint);
      showStatus(
        'info',
        'Print Dialog Closed',
        'The print dialog has been closed.',
        'If you printed or saved a PDF, check your printer queue or the folder you chose.'
      );
    };
    window.addEventListener('afterprint', onAfterPrint);

    setTimeout(() => window.print(), 100);
  };

  const requestSaveConfirmation = () => {
    writeAutosaveNow();
    if (isOfflineNow()) {
      showNoInternetDialog();
      return;
    }
    if (!confirmSaveOpen && !isSaving && !statusDialog.open) {
      setConfirmSaveOpen(true);
    }
  };

  useEnterToSave({
    enabled:
      !confirmSaveOpen &&
      !floatingInput.visible &&
      !isDatabaseDialogOpen &&
      !viewingRecord &&
      !editingRecord &&
      !deletingRecord &&
      !statusDialog.open,
    onTriggerSave: () => {
      requestSaveConfirmation();
    },
  });

  const buildSupabaseRowForTab = (
    resolvedPrNo?: string,
    resolvedPoNo?: string
  ): Record<string, unknown> => {
    const fullPayload = buildCurrentPayload();
    const actor = (createdBy || prRequestedBy || 'HON. EFREN F. CORPUZ').trim();

    if (activeTab === 'pr') {
      const effectivePrNo = resolvedPrNo || prFormNo;
      return {
        id: recordUuid,
        pr_number: effectivePrNo,
        barangay: 'Kauswagan',
        city: 'Cagayan de Oro City',
        province: 'Misamis Oriental',
        purpose: (prPurpose ?? '').trim() || 'Purchase Request',
        total_amount: prTotal,
        amount_in_words: prTotal ? amountToPesoWords(prTotal) : '',
        items: prItems,
        requested_by: { name: prRequestedBy, role: prRequestedRole },
        approved_by: { name: prApprovedBy, role: prApprovedRole },
        requested_date: prFormDate || null,
        approved_date: prFormDate || null,
        created_by: actor,
      };
    }

    if (activeTab === 'rfq') {
      return {
        id: recordUuid,
        pr_number: rfqPrNo || null,
        date: rfqDate || null,
        dealer_name: rfqDealer || null,
        dealer_address: rfqAddress || null,
        proposal_quotation_title: rfqProposal || null,
        bac_chairman_name: rfqBacChair || null,
        items: rfqItems,
        delivery_period: rfqDeliveryWillBe || null,
        fob_location: rfqFob || null,
        fob_destination: rfqFod || null,
        created_by: actor,
      };
    }

    if (activeTab === 'abstract') {
      return {
        id: recordUuid,
        pr_number: absPrNo || null,
        title: absProposal || 'Abstract of Quotation',
        date: absDated || null,
        opened_at: absOpened || null,
        items: absRows,
        bidders: [absEntity1, absEntity2, absEntity3].filter(Boolean),
        winning_bidder_name: { label: absWinner },
        approved_forwarded_by: absForwardedBy,
        action_committee_taken_by: absActionBy,
        bac_chairperson: absBacChair,
        bac_vice_chairperson: absBacViceChair,
        bac_secretariat: absBacSec,
        bac_members: [absMem1, absMem2, absMem3, absMem4, absMem5],
        created_by: actor,
      };
    }

    if (activeTab === 'po') {
      const effectivePoNo = resolvedPoNo || poNumber;
      return {
        id: recordUuid,
        po_number: effectivePoNo,
        barangay: 'Kauswagan',
        city: 'Cagayan de Oro City',
        province: 'Misamis Oriental',
        supplier_name: poSupplier || 'Supplier',
        supplier_address: poAddress || null,
        supplier_tin: poTin || null,
        mode_of_procurement: poMode,
        place_of_delivery: poDeliveryPlace || null,
        date_of_delivery: poDeliveryDate || null,
        delivery_term: poDeliveryTerm || null,
        payment_term: poPaymentTerm || null,
        items: poItems,
        total_amount: poTotal,
        sk_chairperson_name: poChair,
        conforme_supplier_name: poConforme || null,
        budget_officer_name: poBudgetOfficer,
        created_by: actor,
      };
    }

    return {
      id: recordUuid,
      barangay: 'Kauswagan',
      city: 'Cagayan de Oro City',
      province: 'Misamis Oriental',
      po_number: iarPoNo || null,
      supplier_name: iarSupplier || 'Supplier',
      supplier_address: iarAddress || null,
      invoice_number: iarInvoiceNo || null,
      invoice_date: iarInvoiceDate || null,
      air_number: iarAirNo || null,
      air_date: iarAirDate || null,
      cntrl_ris_number: iarRisNo || null,
      cntrl_ris_date: iarRisDate || null,
      items: iarItems,
      date_inspected: iarDateInspected || null,
      is_verified_ok: iarStatus === 'Complete',
      date_received: iarDateReceived || null,
      acceptance_status: iarStatus === 'Partial' ? 'partial' : 'accepted',
      inspector_name: iarTreasurer,
      inspection_officer_name: iarInspector,
      created_by: actor || fullPayload.createdBy || null,
    };
  };

  const handleSaveToSupabase = async (): Promise<ProcurementDbRecord[]> => {
    if (isOfflineNow()) {
      writeAutosaveNow();
      throw new Error(
        'No internet connection. Changes are saved locally for your account.'
      );
    }

    const selectCols =
      activeTab === 'pr'
        ? 'id, pr_number, updated_at'
        : activeTab === 'po'
        ? 'id, po_number, updated_at'
        : 'id, updated_at';

    const { data: existingRows, error: fetchError } = await supabase
      .from(currentTabMeta.tableName as never)
      .select(selectCols);

    if (fetchError) {
      throw new Error(fetchError.message);
    }

    const existingList = (existingRows ?? []) as {
      id: string;
      pr_number?: string;
      po_number?: string;
      updated_at?: string;
    }[];

    const existingSameRecord = existingList.find((r) => r.id === recordUuid);

    if (
      existingSameRecord &&
      loadedUpdatedAt &&
      existingSameRecord.updated_at &&
      existingSameRecord.updated_at !== loadedUpdatedAt
    ) {
      throw new Error(
        'Concurrent edit conflict: Another user modified this record while you were editing it. Open Database and load the latest version before saving.'
      );
    }

    let resolvedPrNo = prFormNo;
    let resolvedPoNo = poNumber;

    if (activeTab === 'pr') {
      const dbPrNos = existingList
        .filter((r) => r.id !== recordUuid)
        .map((r) => r.pr_number)
        .filter((v): v is string => Boolean(v));
      if (!existingSameRecord && dbPrNos.includes(resolvedPrNo)) {
        resolvedPrNo = generateUniqueDocNumber([...dbPrNos, ...usedPrNumbers]);
        setPrFormNo(resolvedPrNo);
      }
    }

    if (activeTab === 'po') {
      const dbPoNos = existingList
        .filter((r) => r.id !== recordUuid)
        .map((r) => r.po_number)
        .filter((v): v is string => Boolean(v));
      if (!existingSameRecord && dbPoNos.includes(resolvedPoNo)) {
        resolvedPoNo = generateUniqueDocNumber([...dbPoNos, ...usedPoNumbers]);
        setPoNumber(resolvedPoNo);
      }
    }

    const resolvedFinalId =
      activeTab === 'pr'
        ? resolvedPrNo
        : activeTab === 'po'
        ? resolvedPoNo
        : getDefaultFinalIdForCurrentTab();
    setFinalId(resolvedFinalId);

    const supabaseRow = buildSupabaseRowForTab(resolvedPrNo, resolvedPoNo);
    const { error } = await supabase
      .from(currentTabMeta.tableName as never)
      .upsert(supabaseRow as never, { onConflict: 'id' });

    if (error) {
      throw new Error(error.message);
    }

    const latestRecords = await loadProcurementRecordsFromSupabase(false);
    showStatus(
      'success',
      'Saved to Supabase',
      `Saved (${resolvedFinalId}) to ${currentTabMeta.tableName}.`
    );
    return latestRecords;
  };

  const advanceNumbersAfterSave = (latestRecords: ProcurementDbRecord[]) => {
    const dbPrNos = latestRecords
      .filter((r) => r.docType === 'pr' || r.tableName === 'purchase_request')
      .map((r) => r.finalId || r.payload?.prFormNo)
      .filter((v): v is string => Boolean(v));

    const dbPoNos = latestRecords
      .filter((r) => r.docType === 'po' || r.tableName === 'purchase_order')
      .map((r) => r.finalId || r.payload?.poNumber)
      .filter((v): v is string => Boolean(v));

    const freshUuid = crypto.randomUUID();
    setRecordUuid(freshUuid);
    setLoadedUpdatedAt(null);

    if (activeTab === 'pr') {
      const allUsedPr = Array.from(
        new Set([...usedPrNumbers, ...dbPrNos, prFormNo])
      );
      const nextPrNo = generateUniqueDocNumber(allUsedPr);
      const freshItems: LineItem[] = [
        {
          id: `pr-${crypto.randomUUID()}`,
          itemNo: '1',
          qty: 0,
          unit: 'Pax',
          description: '',
          unitCost: 0,
        },
      ];

      setUsedPrNumbers(allUsedPr);
      setPrFormNo(nextPrNo);
      setFinalId(nextPrNo);
      setPrPurpose('');
      setPrItems(freshItems);
      writeAutosaveNow(
        freshUuid,
        {
          ...buildCurrentPayload(),
          prFormNo: nextPrNo,
          prPurpose: '',
          prItems: freshItems,
        },
        null
      );
      return;
    }

    if (activeTab === 'rfq') {
      const nextId = rfqPrNo
        ? `RFQ-${rfqPrNo}`
        : `RFQ-${freshUuid.slice(0, 8).toUpperCase()}`;
      setFinalId(nextId);
      setRfqDate('');
      setRfqDealer('');
      setRfqAddress('');
      setRfqProposal('');
      setRfqFod('');
      setRfqDeliveryWillBe('');
      setRfqFob('');
      setRfqGoodItemsUnitYear('');
      setRfqItems([]);
      writeAutosaveNow(
        freshUuid,
        {
          ...buildCurrentPayload(),
          rfqDate: '',
          rfqDealer: '',
          rfqAddress: '',
          rfqProposal: '',
          rfqFod: '',
          rfqDeliveryWillBe: '',
          rfqFob: '',
          rfqGoodItemsUnitYear: '',
          rfqItems: [],
        },
        null
      );
      return;
    }

    if (activeTab === 'abstract') {
      const nextId = absPrNo
        ? `ABS-${absPrNo}`
        : `ABS-${freshUuid.slice(0, 8).toUpperCase()}`;
      const freshAbsRows: AbstractRow[] = [
        {
          id: `abs-${crypto.randomUUID()}`,
          itemNo: '1',
          qty: 0,
          unit: 'Pax',
          description: '',
          bid1: 0,
          bid2: 0,
          bid3: 0,
        },
      ];
      setFinalId(nextId);
      setAbsProposal('');
      setAbsPrNo('');
      setAbsDated('');
      setAbsOpened('');
      setAbsEntity1('');
      setAbsEntity2('');
      setAbsEntity3('');
      setAbsWinner('');
      setAbsRows(freshAbsRows);
      writeAutosaveNow(
        freshUuid,
        {
          ...buildCurrentPayload(),
          absProposal: '',
          absPrNo: '',
          absDated: '',
          absOpened: '',
          absEntity1: '',
          absEntity2: '',
          absEntity3: '',
          absWinner: '',
          absRows: freshAbsRows,
        },
        null
      );
      return;
    }

    if (activeTab === 'po') {
      const savedPoNo = poNumber;
      const savedPoItems = poItems;
      const allUsedPo = Array.from(
        new Set([...usedPoNumbers, ...dbPoNos, savedPoNo])
      );
      const nextPoNo = generateUniqueDocNumber(allUsedPo);
      const freshPoItems: LineItem[] = [
        {
          id: `po-${crypto.randomUUID()}`,
          itemNo: '1',
          qty: 0,
          unit: 'Pax',
          description: '',
          unitCost: 0,
        },
      ];
      const nextIarItems: IarItem[] = savedPoItems.map((item, idx) => ({
        id: `iar-${item.id}-${idx}`,
        unit: item.unit || 'Pax',
        description: item.description,
        qty: item.qty,
      }));

      setUsedPoNumbers(allUsedPo);
      setIarPoNo(savedPoNo);
      if (poSupplier) setIarSupplier(poSupplier);
      if (poAddress) setIarAddress(poAddress);
      setIarItems(nextIarItems);

      setFinalId(savedPoNo);
      setPoSupplier('');
      setPoAddress('');
      setPoTin('');
      setPoDeliveryPlace('');
      setPoDeliveryDate('');
      setPoDeliveryTerm('');
      setPoPaymentTerm('');
      setPoConforme('');
      setPoItems(freshPoItems);

      writeAutosaveNow(
        freshUuid,
        {
          ...buildCurrentPayload(),
          poNumber: nextPoNo,
          poSupplier: '',
          poAddress: '',
          poTin: '',
          poDeliveryPlace: '',
          poDeliveryDate: '',
          poDeliveryTerm: '',
          poPaymentTerm: '',
          poConforme: '',
          poItems: freshPoItems,
          iarPoNo: savedPoNo,
          iarSupplier: poSupplier || iarSupplier,
          iarAddress: poAddress || iarAddress,
          iarItems: nextIarItems,
        },
        null
      );
      return;
    }

    const nextIarId = iarPoNo
      ? `IAR-${iarPoNo}`
      : `IAR-${freshUuid.slice(0, 8).toUpperCase()}`;
    setFinalId(nextIarId);
    setIarSupplier('');
    setIarAddress('');
    setIarInvoiceNo('');
    setIarInvoiceDate('');
    setIarAirNo('');
    setIarAirDate('');
    setIarRisNo('');
    setIarRisDate('');
    setIarDateInspected('');
    setIarDateReceived('');
    setIarStatus('Complete');
    setIarItems([]);
    writeAutosaveNow(
      freshUuid,
      {
        ...buildCurrentPayload(),
        iarSupplier: '',
        iarAddress: '',
        iarInvoiceNo: '',
        iarInvoiceDate: '',
        iarAirNo: '',
        iarAirDate: '',
        iarRisNo: '',
        iarRisDate: '',
        iarDateInspected: '',
        iarDateReceived: '',
        iarStatus: 'Complete',
        iarItems: [],
      },
      null
    );
  };

  const handleConfirmSave = async () => {
    if (isOfflineNow()) {
      setConfirmSaveOpen(false);
      writeAutosaveNow();
      showNoInternetDialog();
      return;
    }

    setIsSaving(true);
    try {
      const latestRecords = await handleSaveToSupabase();
      advanceNumbersAfterSave(latestRecords);
      setConfirmSaveOpen(false);
    } catch (err) {
      setConfirmSaveOpen(false);
      showStatus(
        'error',
        'Save Failed',
        'Could not save the record to Supabase.',
        err instanceof Error ? err.message : 'Please try again.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const openEditDialog = (rec: ProcurementDbRecord) => {
    setEditingRecord(rec);
    setEditTitleDraft(rec.title || '');
    setEditDateDraft(rec.dateText || '');
  };

  const handleConfirmEditLoad = () => {
    if (!editingRecord) return;
    const rec = editingRecord;
    const p = rec.payload;
    const nextTitle = editTitleDraft.trim() || rec.title;
    const nextDate = editDateDraft.trim() || rec.dateText;

    setFinalId(rec.finalId);
    applyPayloadToEditor(
      {
        ...p,
        prFormDate: p.activeTab === 'pr' ? nextDate : p.prFormDate,
        prPurpose: p.activeTab === 'pr' ? nextTitle : p.prPurpose,
        rfqDate: p.activeTab === 'rfq' ? nextDate : p.rfqDate,
        rfqDealer: p.activeTab === 'rfq' ? nextTitle : p.rfqDealer,
        absProposal: p.activeTab === 'abstract' ? nextTitle : p.absProposal,
        absDated: p.activeTab === 'abstract' ? nextDate : p.absDated,
        poDate: p.activeTab === 'po' ? nextDate : p.poDate,
        poSupplier: p.activeTab === 'po' ? nextTitle : p.poSupplier,
        iarSupplier: p.activeTab === 'iar' ? nextTitle : p.iarSupplier,
        iarDateInspected:
          p.activeTab === 'iar' ? nextDate : p.iarDateInspected,
      },
      rec.id,
      rec.updatedAt || null
    );

    setEditingRecord(null);
    setIsDatabaseDialogOpen(false);
    showStatus(
      'info',
      'Record Loaded',
      `Loaded ${rec.finalId || 'record'} into the editor.`
    );
  };

  const handleConfirmDeleteRecord = async () => {
    if (!deletingRecord) return;
    if (isOfflineNow()) {
      setDeletingRecord(null);
      showNoInternetDialog();
      return;
    }

    setIsDeleting(true);
    try {
      const rec = deletingRecord;
      const { data: deletedRows, error } = await supabase
        .from(rec.tableName as never)
        .delete()
        .eq('id' as never, rec.id as never)
        .select('id');

      if (error) {
        throw new Error(error.message);
      }

      if (!deletedRows || deletedRows.length === 0) {
        throw new Error(
          `No row with id "${rec.id}" was deleted from "${rec.tableName}". Check Supabase Row-Level Security (RLS) DELETE policies for this table.`
        );
      }

      await loadProcurementRecordsFromSupabase(false);
      if (viewingRecord?.id === rec.id) {
        setViewingRecord(null);
      }
      setDeletingRecord(null);
      showStatus(
        'success',
        'Record Deleted',
        `Deleted ${rec.finalId || 'record'} (${rec.title || 'Untitled'}) from ${rec.tableName}.`
      );
    } catch (err) {
      setDeletingRecord(null);
      showStatus(
        'error',
        'Delete Failed',
        'Could not delete the record from Supabase.',
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const syncCurrentPrRecord = (
    nextItems: LineItem[],
    nextDate = prFormDate,
    nextPurpose = prPurpose,
    nextBy = prRequestedBy,
    nextRole = prRequestedRole
  ) => {
    setPrRecords((prev) => {
      const updatedRecord: PurchaseRequestRecord = {
        prNo: prFormNo,
        date: nextDate,
        purpose: nextPurpose,
        requestedBy: nextBy,
        requestedRole: nextRole,
        items: nextItems,
      };
      const exists = prev.some((r) => r.prNo === prFormNo);
      if (exists) {
        return prev.map((r) => (r.prNo === prFormNo ? updatedRecord : r));
      }
      return [...prev, updatedRecord];
    });
  };

  const handleCreateNewPrNumber = () => {
    const allUsed = Array.from(
      new Set([...usedPrNumbers, ...availableDbPrNumbers, prFormNo])
    );
    const nextPrNo = generateUniqueDocNumber(allUsed);
    setUsedPrNumbers(allUsed);
    setRecordUuid(crypto.randomUUID());
    setLoadedUpdatedAt(null);
    setFinalId(nextPrNo);
    setPrRecords((prev) => {
      const currentSaved: PurchaseRequestRecord = {
        prNo: prFormNo,
        date: prFormDate,
        purpose: prPurpose,
        requestedBy: prRequestedBy,
        requestedRole: prRequestedRole,
        items: prItems,
      };
      const withoutCurrent = prev.filter((r) => r.prNo !== prFormNo);
      const freshRecord: PurchaseRequestRecord = {
        prNo: nextPrNo,
        date: prFormDate,
        purpose: '',
        requestedBy: prRequestedBy,
        requestedRole: prRequestedRole,
        items: [
          {
            id: `pr-${crypto.randomUUID()}`,
            itemNo: '1',
            qty: 1,
            unit: 'Pax',
            description: '',
            unitCost: 0,
          },
        ],
      };
      setPrItems(freshRecord.items);
      setPrPurpose(freshRecord.purpose);
      return [...withoutCurrent, currentSaved, freshRecord];
    });
    setPrFormNo(nextPrNo);
  };

  const handleSelectRfqPrNumber = (selectedPrNo: string) => {
    setRfqPrNo(selectedPrNo);
    const dbMatch = savedDbPrRecords.find(
      (rec) => (rec.finalId || rec.payload?.prFormNo) === selectedPrNo
    );

    if (dbMatch?.payload?.prItems) {
      setRfqItems(
        dbMatch.payload.prItems.map((item, idx) => ({
          id: `rfq-${item.id}-${idx}`,
          itemNo: item.itemNo || String(idx + 1),
          qty: item.qty,
          unit: item.unit || 'Pax',
          description: item.description,
        }))
      );
    }
  };

  const handleCreateNewPoNumber = () => {
    const dbPoNos = dbRecords
      .filter((r) => r.docType === 'po' || r.tableName === 'purchase_order')
      .map((r) => r.finalId || r.payload?.poNumber)
      .filter((v): v is string => Boolean(v));
    const allUsed = Array.from(
      new Set([...usedPoNumbers, ...dbPoNos, poNumber])
    );
    const nextPoNo = generateUniqueDocNumber(allUsed);
    setUsedPoNumbers(allUsed);
    setRecordUuid(crypto.randomUUID());
    setLoadedUpdatedAt(null);
    setFinalId(nextPoNo);
    setPoNumber(nextPoNo);
  };

  const handleSelectIarPoNumber = (selectedPoNo: string) => {
    setIarPoNo(selectedPoNo);
    const dbPoMatch = savedDbPoRecords.find(
      (rec) => (rec.finalId || rec.payload?.poNumber) === selectedPoNo
    );

    if (dbPoMatch?.payload) {
      setIarSupplier(dbPoMatch.payload.poSupplier || '');
      setIarAddress(dbPoMatch.payload.poAddress || '');
      setIarItems(
        Array.isArray(dbPoMatch.payload.poItems)
          ? dbPoMatch.payload.poItems.map((item, idx) => ({
              id: `iar-${item.id}-${idx}`,
              unit: item.unit || 'Pax',
              description: item.description,
              qty: item.qty,
            }))
          : []
      );
    } else if (selectedPoNo === poNumber) {
      setIarSupplier(poSupplier || '');
      setIarAddress(poAddress || '');
      setIarItems(
        poItems.map((item, idx) => ({
          id: `iar-${item.id}-${idx}`,
          unit: item.unit || 'Pax',
          description: item.description,
          qty: item.qty,
        }))
      );
    }
  };

  const InlineEditable = ({
    value,
    onChange,
    placeholder = '',
    className = '',
  }: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    className?: string;
  }) => {
    const handleCommit = (e: React.FormEvent<HTMLSpanElement>) => {
      onChange(e.currentTarget.textContent ?? '');
    };

    return (
      <span
        contentEditable
        suppressContentEditableWarning
        onInput={handleCommit}
        onBlur={handleCommit}
        data-placeholder={placeholder}
        className={`inline-block min-w-8 rounded-xs px-0.5 outline-none transition hover:bg-sky-100/80 focus:bg-sky-100 focus:ring-1 focus:ring-sky-500 empty:before:content-[attr(data-placeholder)] empty:before:text-slate-400 ${className}`}
      >
        {value}
      </span>
    );
  };

  const renderUnitSelect = (
    value: string,
    onChange: (nextUnit: string) => void,
    className = ''
  ) => {
    const normalizedOptions =
      value && !BASIC_UNITS.includes(value) ? [value, ...BASIC_UNITS] : BASIC_UNITS;
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none ${className}`}
      >
        <option value="">—</option>
        {normalizedOptions.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    );
  };

  const renderBarangayHeader = (formTitle: string) => (
    <div className="text-center leading-snug mb-4">
      <p className="text-xs text-slate-900">Republic of the Philippines</p>
      <p className="text-xs text-slate-900">City of Cagayan de Oro</p>
      <p className="text-xs font-bold uppercase text-slate-950">
        SK BARANGAY KAUSWAGAN
      </p>
      <p className="mt-0.5 text-sm font-bold uppercase text-slate-950">
        {formTitle}
      </p>
    </div>
  );

  const renderLineItemInputs = (
    items: LineItem[],
    setItems: React.Dispatch<React.SetStateAction<LineItem[]>>,
    prefix: string,
    onAfterChange?: (updatedItems: LineItem[]) => void
  ) => {
    const addItem = () =>
      setItems((prev) => {
        const next = [
          ...prev,
          {
            id: `${prefix}-${crypto.randomUUID()}`,
            itemNo: String(prev.length + 1),
            qty: 1,
            unit: 'Pax',
            description: '',
            unitCost: 0,
          },
        ];
        onAfterChange?.(next);
        return next;
      });

    const updateItem = <K extends keyof LineItem>(
      id: string,
      key: K,
      val: LineItem[K]
    ) =>
      setItems((prev) => {
        const next = prev.map((item) =>
          item.id === id ? { ...item, [key]: val } : item
        );
        onAfterChange?.(next);
        return next;
      });

    const removeItem = (id: string) =>
      setItems((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((item) => item.id !== id);
        onAfterChange?.(next);
        return next;
      });

    return (
      <div className="space-y-2 pt-2 border-t border-slate-200">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-800">
            Schedule / Items ({items.length})
          </span>
          <button
            type="button"
            onClick={addItem}
            className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Row</span>
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-700 border-b border-slate-200">
              <tr>
                <th className="px-2 py-2 text-left font-semibold w-12">#</th>
                <th className="px-2 py-2 text-left font-semibold w-16">Qty</th>
                <th className="px-2 py-2 text-left font-semibold w-24">Unit</th>
                <th className="px-2 py-2 text-left font-semibold">
                  Description
                </th>
                <th className="px-2 py-2 text-right font-semibold w-24">
                  Unit Cost
                </th>
                <th className="px-2 py-2 w-8" aria-label="Remove row" />
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-200">
              {items.map((row) => (
                <tr key={row.id} className="bg-white hover:bg-slate-50/70">
                  <td className="px-1.5 py-1.5">
                    <input
                      type="text"
                      value={row.itemNo}
                      placeholder="#"
                      onChange={(e) =>
                        updateItem(row.id, 'itemNo', e.target.value)
                      }
                      onFocus={(e) =>
                        openFloatingInput(
                          e.currentTarget,
                          'text',
                          row.itemNo,
                          (next) => updateItem(row.id, 'itemNo', next)
                        )
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input
                      type="number"
                      value={row.qty === 0 ? '' : row.qty}
                      placeholder="0"
                      onChange={(e) =>
                        updateItem(row.id, 'qty', Number(e.target.value))
                      }
                      onFocus={(e) =>
                        openFloatingInput(
                          e.currentTarget,
                          'number',
                          row.qty,
                          (next) => updateItem(row.id, 'qty', Number(next)),
                          'right'
                        )
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-1.5 py-1.5">
                    {renderUnitSelect(row.unit, (nextUnit) =>
                      updateItem(row.id, 'unit', nextUnit)
                    )}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input
                      type="text"
                      value={row.description}
                      placeholder="Description"
                      onChange={(e) =>
                        updateItem(row.id, 'description', e.target.value)
                      }
                      onFocus={(e) =>
                        openFloatingInput(
                          e.currentTarget,
                          'text',
                          row.description,
                          (next) => updateItem(row.id, 'description', next)
                        )
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <input
                      type="number"
                      value={row.unitCost === 0 ? '' : row.unitCost}
                      placeholder="0"
                      onChange={(e) =>
                        updateItem(row.id, 'unitCost', Number(e.target.value))
                      }
                      onFocus={(e) =>
                        openFloatingInput(
                          e.currentTarget,
                          'number',
                          row.unitCost,
                          (next) =>
                            updateItem(row.id, 'unitCost', Number(next)),
                          'right'
                        )
                      }
                      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                    />
                  </td>
                  <td className="px-1.5 py-1.5 text-center">
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(row.id)}
                        title="Remove row"
                        className="inline-flex items-center justify-center rounded p-1 text-rose-500 hover:bg-rose-50 hover:text-rose-700 transition cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderFormInputs = () => {
    switch (activeTab) {
      case 'pr':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label className="block text-xs font-medium text-slate-700">
                    P.R No. (Auto)
                  </label>
                  <button
                    type="button"
                    onClick={handleCreateNewPrNumber}
                    className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                  >
                    + New PR No.
                  </button>
                </div>
                <input
                  type="text"
                  value={prFormNo}
                  readOnly
                  aria-readonly="true"
                  className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-700 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date (YYYY-MM-DD)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={prFormDate}
                  onChange={(e) => {
                    const val = formatAutoDashDate(e.target.value);
                    setPrFormDate(val);
                    syncCurrentPrRecord(prItems, val);
                  }}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Purpose
              </label>
              <input
                type="text"
                value={prPurpose}
                onChange={(e) => {
                  const val = e.target.value;
                  setPrPurpose(val);
                  syncCurrentPrRecord(prItems, prFormDate, val);
                }}
                onFocus={(e) =>
                  openFloatingInput(e.currentTarget, 'text', prPurpose, (next) => {
                    setPrPurpose(next);
                    syncCurrentPrRecord(prItems, prFormDate, next);
                  })
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Requested By
              </label>
              <select
                value={prRequestedBy}
                onChange={(e) => {
                  const selectedName = e.target.value;
                  const found = PREPARED_BY_OPTIONS.find(
                    (opt) => opt.name === selectedName
                  );
                  const nextRole = found ? found.role : prRequestedRole;
                  setPrRequestedBy(selectedName);
                  if (found) setPrRequestedRole(nextRole);
                  syncCurrentPrRecord(
                    prItems,
                    prFormDate,
                    prPurpose,
                    selectedName,
                    nextRole
                  );
                }}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                {PREPARED_BY_OPTIONS.map((opt) => (
                  <option key={`${opt.name}-${opt.role}`} value={opt.name}>
                    {opt.name} ({opt.role})
                  </option>
                ))}
              </select>
            </div>

            {renderLineItemInputs(prItems, setPrItems, 'pr', (nextItems) =>
              syncCurrentPrRecord(nextItems)
            )}
          </div>
        );

      case 'rfq':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Purchase Request No.
                </label>
                {availableDbPrNumbers.length === 0 ? (
                  <input
                    type="text"
                    value={rfqPrNo}
                    onChange={(e) => setRfqPrNo(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-800"
                  />
                ) : (
                  <select
                    value={rfqPrNo}
                    onChange={(e) => handleSelectRfqPrNumber(e.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800"
                  >
                    <option value={rfqPrNo}>{rfqPrNo || 'Select PR No.'}</option>
                    {availableDbPrNumbers.map((num) => (
                      <option key={num} value={num}>
                        {num}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date (YYYY-MM-DD)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={rfqDate}
                  onChange={(e) =>
                    setRfqDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Dealer
              </label>
              <input
                type="text"
                value={rfqDealer}
                onChange={(e) => setRfqDealer(e.target.value)}
                onFocus={(e) =>
                  openFloatingInput(e.currentTarget, 'text', rfqDealer, (next) =>
                    setRfqDealer(next)
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Address
              </label>
              <input
                type="text"
                value={rfqAddress}
                onChange={(e) => setRfqAddress(e.target.value)}
                onFocus={(e) =>
                  openFloatingInput(
                    e.currentTarget,
                    'text',
                    rfqAddress,
                    (next) => setRfqAddress(next)
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Proposal / Quotation
              </label>
              <input
                type="text"
                value={rfqProposal}
                onChange={(e) => setRfqProposal(e.target.value)}
                onFocus={(e) =>
                  openFloatingInput(
                    e.currentTarget,
                    'text',
                    rfqProposal,
                    (next) => setRfqProposal(next)
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-200">
              <span className="block text-xs font-semibold text-slate-800">
                Quotation Blank Fields
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700">
                    FOD Blank
                  </label>
                  <input
                    type="text"
                    value={rfqFod}
                    onChange={(e) => setRfqFod(e.target.value)}
                    onFocus={(e) =>
                      openFloatingInput(
                        e.currentTarget,
                        'text',
                        rfqFod,
                        (next) => setRfqFod(next)
                      )
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700">
                    Delivery Will Be Blank
                  </label>
                  <input
                    type="text"
                    value={rfqDeliveryWillBe}
                    onChange={(e) => setRfqDeliveryWillBe(e.target.value)}
                    onFocus={(e) =>
                      openFloatingInput(
                        e.currentTarget,
                        'text',
                        rfqDeliveryWillBe,
                        (next) => setRfqDeliveryWillBe(next)
                      )
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700">
                    FOB Blank
                  </label>
                  <input
                    type="text"
                    value={rfqFob}
                    onChange={(e) => setRfqFob(e.target.value)}
                    onFocus={(e) =>
                      openFloatingInput(
                        e.currentTarget,
                        'text',
                        rfqFob,
                        (next) => setRfqFob(next)
                      )
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700">
                    Good Items/Unit Year Blank
                  </label>
                  <input
                    type="text"
                    value={rfqGoodItemsUnitYear}
                    onChange={(e) => setRfqGoodItemsUnitYear(e.target.value)}
                    onFocus={(e) =>
                      openFloatingInput(
                        e.currentTarget,
                        'text',
                        rfqGoodItemsUnitYear,
                        (next) => setRfqGoodItemsUnitYear(next)
                      )
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
                <span>Quotation Schedule Items ({rfqItems.length})</span>
                <span className="text-slate-500 font-normal">
                  Cost left blank for supplier
                </span>
              </div>
              {rfqItems.length === 0 ? (
                <p className="text-[11px] text-slate-500 py-1">
                  Save a Purchase Request first to load its items here.
                </p>
              ) : (
                <div className="divide-y divide-slate-200 text-[11px]">
                  {rfqItems.map((it) => (
                    <div
                      key={it.id}
                      className="py-1 flex items-center justify-between gap-2 text-slate-700"
                    >
                      <span className="truncate">
                        #{it.itemNo || '1'} • {it.description || 'Untitled Item'}
                      </span>
                      <span className="shrink-0 font-medium">
                        {it.qty || ''} {it.unit}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      case 'abstract': {
        const addAbsRow = () =>
          setAbsRows((prev) => [
            ...prev,
            {
              id: `abs-${crypto.randomUUID()}`,
              itemNo: String(prev.length + 1),
              qty: 0,
              unit: 'Pax',
              description: '',
              bid1: 0,
              bid2: 0,
              bid3: 0,
            },
          ]);

        const updateAbsRow = <K extends keyof AbstractRow>(
          id: string,
          key: K,
          val: AbstractRow[K]
        ) =>
          setAbsRows((prev) =>
            prev.map((r) => (r.id === id ? { ...r, [key]: val } : r))
          );

        const removeAbsRow = (id: string) =>
          setAbsRows((prev) =>
            prev.length > 1 ? prev.filter((r) => r.id !== id) : prev
          );

        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Abstract Of Proposal
                </label>
                <input
                  type="text"
                  value={absProposal}
                  onChange={(e) => setAbsProposal(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      absProposal,
                      (next) => setAbsProposal(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Per P.R No.
                </label>
                <input
                  type="text"
                  value={absPrNo}
                  onChange={(e) => setAbsPrNo(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      absPrNo,
                      (next) => setAbsPrNo(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Dated (YYYY-MM-DD)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={absDated}
                  onChange={(e) =>
                    setAbsDated(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date/Time Opened
                </label>
                <input
                  type="text"
                  value={absOpened}
                  onChange={(e) => setAbsOpened(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Entity 1
                </label>
                <input
                  type="text"
                  value={absEntity1}
                  onChange={(e) => setAbsEntity1(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      absEntity1,
                      (next) => setAbsEntity1(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Entity 2
                </label>
                <input
                  type="text"
                  value={absEntity2}
                  onChange={(e) => setAbsEntity2(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      absEntity2,
                      (next) => setAbsEntity2(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Entity 3
                </label>
                <input
                  type="text"
                  value={absEntity3}
                  onChange={(e) => setAbsEntity3(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      absEntity3,
                      (next) => setAbsEntity3(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Winning Bidder
              </label>
              <input
                type="text"
                value={absWinner}
                onChange={(e) => setAbsWinner(e.target.value)}
                onFocus={(e) =>
                  openFloatingInput(
                    e.currentTarget,
                    'text',
                    absWinner,
                    (next) => setAbsWinner(next)
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">
                  Bidder Quotations ({absRows.length})
                </span>
                <button
                  type="button"
                  onClick={addAbsRow}
                  className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Row</span>
                </button>
              </div>

              <div className="max-h-72 overflow-y-auto overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-slate-700 border-b border-slate-200">
                    <tr>
                      <th className="px-2 py-2 text-left font-semibold w-12">
                        #
                      </th>
                      <th className="px-2 py-2 text-left font-semibold w-16">
                        Qty
                      </th>
                      <th className="px-2 py-2 text-left font-semibold w-24">
                        Unit
                      </th>
                      <th className="px-2 py-2 text-left font-semibold min-w-28">
                        Description
                      </th>
                      <th className="px-2 py-2 text-right font-semibold w-20">
                        B1
                      </th>
                      <th className="px-2 py-2 text-right font-semibold w-20">
                        B2
                      </th>
                      <th className="px-2 py-2 text-right font-semibold w-20">
                        B3
                      </th>
                      <th className="px-2 py-2 w-8" aria-label="Remove row" />
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-200">
                    {absRows.map((row) => (
                      <tr key={row.id} className="bg-white hover:bg-slate-50/70">
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            value={row.itemNo}
                            placeholder="#"
                            onChange={(e) =>
                              updateAbsRow(row.id, 'itemNo', e.target.value)
                            }
                            onFocus={(e) =>
                              openFloatingInput(
                                e.currentTarget,
                                'text',
                                row.itemNo,
                                (next) => updateAbsRow(row.id, 'itemNo', next)
                              )
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="number"
                            value={row.qty === 0 ? '' : row.qty}
                            placeholder="0"
                            onChange={(e) =>
                              updateAbsRow(row.id, 'qty', Number(e.target.value))
                            }
                            onFocus={(e) =>
                              openFloatingInput(
                                e.currentTarget,
                                'number',
                                row.qty,
                                (next) =>
                                  updateAbsRow(row.id, 'qty', Number(next)),
                                'right'
                              )
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          {renderUnitSelect(row.unit, (nextUnit) =>
                            updateAbsRow(row.id, 'unit', nextUnit)
                          )}
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            value={row.description}
                            placeholder="Description"
                            onChange={(e) =>
                              updateAbsRow(
                                row.id,
                                'description',
                                e.target.value
                              )
                            }
                            onFocus={(e) =>
                              openFloatingInput(
                                e.currentTarget,
                                'text',
                                row.description,
                                (next) =>
                                  updateAbsRow(row.id, 'description', next)
                              )
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="number"
                            value={row.bid1 === 0 ? '' : row.bid1}
                            placeholder="0"
                            onChange={(e) =>
                              updateAbsRow(
                                row.id,
                                'bid1',
                                Number(e.target.value)
                              )
                            }
                            onFocus={(e) =>
                              openFloatingInput(
                                e.currentTarget,
                                'number',
                                row.bid1,
                                (next) =>
                                  updateAbsRow(row.id, 'bid1', Number(next)),
                                'right'
                              )
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="number"
                            value={row.bid2 === 0 ? '' : row.bid2}
                            placeholder="0"
                            onChange={(e) =>
                              updateAbsRow(
                                row.id,
                                'bid2',
                                Number(e.target.value)
                              )
                            }
                            onFocus={(e) =>
                              openFloatingInput(
                                e.currentTarget,
                                'number',
                                row.bid2,
                                (next) =>
                                  updateAbsRow(row.id, 'bid2', Number(next)),
                                'right'
                              )
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="number"
                            value={row.bid3 === 0 ? '' : row.bid3}
                            placeholder="0"
                            onChange={(e) =>
                              updateAbsRow(
                                row.id,
                                'bid3',
                                Number(e.target.value)
                              )
                            }
                            onFocus={(e) =>
                              openFloatingInput(
                                e.currentTarget,
                                'number',
                                row.bid3,
                                (next) =>
                                  updateAbsRow(row.id, 'bid3', Number(next)),
                                'right'
                              )
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                          />
                        </td>
                        <td className="px-1.5 py-1.5 text-center">
                          {absRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeAbsRow(row.id)}
                              title="Remove row"
                              className="inline-flex items-center justify-center rounded p-1 text-rose-500 hover:bg-rose-50 hover:text-rose-700 transition cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      }

      case 'po':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label className="block text-xs font-medium text-slate-700">
                    PO No.
                  </label>
                  <button
                    type="button"
                    onClick={handleCreateNewPoNumber}
                    className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                  >
                    + New PO No.
                  </button>
                </div>
                <input
                  type="text"
                  value={poNumber}
                  readOnly
                  aria-readonly="true"
                  className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-700 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date (YYYY-MM-DD)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={poDate}
                  onChange={(e) =>
                    setPoDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Supplier
              </label>
              <input
                type="text"
                value={poSupplier}
                onChange={(e) => setPoSupplier(e.target.value)}
                onFocus={(e) =>
                  openFloatingInput(
                    e.currentTarget,
                    'text',
                    poSupplier,
                    (next) => setPoSupplier(next)
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Address
                </label>
                <input
                  type="text"
                  value={poAddress}
                  onChange={(e) => setPoAddress(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      poAddress,
                      (next) => setPoAddress(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  TIN
                </label>
                <input
                  type="text"
                  value={poTin}
                  onChange={(e) => setPoTin(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(e.currentTarget, 'text', poTin, (next) =>
                      setPoTin(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Mode of Procurement
                </label>
                <select
                  value={poMode}
                  onChange={(e) =>
                    setPoMode(
                      e.target.value as
                        | 'Shopping'
                        | 'Negotiated'
                        | 'Over the Counter'
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                >
                  <option value="Shopping">Shopping</option>
                  <option value="Negotiated">Negotiated</option>
                  <option value="Over the Counter">Over the Counter</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Place of Delivery
                </label>
                <input
                  type="text"
                  value={poDeliveryPlace}
                  onChange={(e) => setPoDeliveryPlace(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      poDeliveryPlace,
                      (next) => setPoDeliveryPlace(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date of Delivery
                </label>
                <input
                  type="text"
                  value={poDeliveryDate}
                  onChange={(e) => setPoDeliveryDate(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Delivery Term
                </label>
                <input
                  type="text"
                  value={poDeliveryTerm}
                  onChange={(e) => setPoDeliveryTerm(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      poDeliveryTerm,
                      (next) => setPoDeliveryTerm(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Payment Term
                </label>
                <input
                  type="text"
                  value={poPaymentTerm}
                  onChange={(e) => setPoPaymentTerm(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      poPaymentTerm,
                      (next) => setPoPaymentTerm(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Conforme Supplier
                </label>
                <input
                  type="text"
                  value={poConforme}
                  onChange={(e) => setPoConforme(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      poConforme,
                      (next) => setPoConforme(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            {renderLineItemInputs(poItems, setPoItems, 'po')}
          </div>
        );

      case 'iar':
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                P.O. No. (From Saved Purchase Orders)
              </label>
              <select
                value={iarPoNo}
                onChange={(e) => handleSelectIarPoNumber(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800"
              >
                <option value="">Select PO No.</option>
                {availableDbPoNumbers.map((num) => (
                  <option key={num} value={num}>
                    {num}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Supplier
                </label>
                <input
                  type="text"
                  value={iarSupplier}
                  onChange={(e) => setIarSupplier(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      iarSupplier,
                      (next) => setIarSupplier(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Address
                </label>
                <input
                  type="text"
                  value={iarAddress}
                  onChange={(e) => setIarAddress(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      iarAddress,
                      (next) => setIarAddress(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Invoice No.
                </label>
                <input
                  type="text"
                  value={iarInvoiceNo}
                  onChange={(e) => setIarInvoiceNo(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      iarInvoiceNo,
                      (next) => setIarInvoiceNo(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Invoice Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={iarInvoiceDate}
                  onChange={(e) =>
                    setIarInvoiceDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  AIR No.
                </label>
                <input
                  type="text"
                  value={iarAirNo}
                  onChange={(e) => setIarAirNo(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      iarAirNo,
                      (next) => setIarAirNo(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  AIR Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={iarAirDate}
                  onChange={(e) =>
                    setIarAirDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Cntrl RIS No.
                </label>
                <input
                  type="text"
                  value={iarRisNo}
                  onChange={(e) => setIarRisNo(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      iarRisNo,
                      (next) => setIarRisNo(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  RIS Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={iarRisDate}
                  onChange={(e) =>
                    setIarRisDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date Inspected
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={iarDateInspected}
                  onChange={(e) =>
                    setIarDateInspected(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Date Received
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={iarDateReceived}
                  onChange={(e) =>
                    setIarDateReceived(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Acceptance Status
              </label>
              <select
                value={iarStatus}
                onChange={(e) =>
                  setIarStatus(e.target.value as 'Complete' | 'Partial')
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                <option value="Complete">Complete</option>
                <option value="Partial">Partial</option>
              </select>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
                <span>Fetched DB PO Items ({iarItems.length})</span>
                <span className="text-slate-500 font-normal">
                  Synced with PO #{iarPoNo || '—'}
                </span>
              </div>
              {iarItems.length === 0 ? (
                <p className="text-[11px] text-slate-500 py-1">
                  Save a Purchase Order first to load its items here.
                </p>
              ) : (
                <div className="divide-y divide-slate-200 text-[11px]">
                  {iarItems.map((it, idx) => (
                    <div
                      key={it.id}
                      className="py-1 flex items-center justify-between gap-2 text-slate-700"
                    >
                      <span className="truncate">
                        #{idx + 1} • {it.description || 'Untitled Item'}
                      </span>
                      <span className="shrink-0 font-medium">
                        {it.qty || ''} {it.unit}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
    }
  };

  const renderPaperSheetContent = () => {
    switch (activeTab) {
      case 'pr': {
        const blankCount = Math.max(0, 3 - prItems.length);
        return (
          <div className="w-full max-w-full overflow-hidden text-xs text-slate-950 space-y-4">
            <h1 className="text-center text-sm font-bold uppercase tracking-wide">
              PURCHASE REQUEST
            </h1>

            <div className="grid grid-cols-12 gap-x-3 gap-y-0.5 text-[11px] leading-snug">
              <div className="col-span-7">
                Barangay: <strong>Kauswagan</strong>
              </div>
              <div className="col-span-5">
                P.R No.: <strong>{prFormNo}</strong>
              </div>
              <div className="col-span-7">
                City/Municipality: <strong>Cagayan De Oro</strong>
              </div>
              <div className="col-span-5">
                Date:{' '}
                <strong className="underline">
                  <InlineEditable
                    value={prFormDate}
                    onChange={(v) => {
                      const formatted = formatAutoDashDate(v);
                      setPrFormDate(formatted);
                      syncCurrentPrRecord(prItems, formatted);
                    }}
                  />
                </strong>
              </div>
              <div className="col-span-7">
                Province: <strong>Misamis Oriental</strong>
              </div>
            </div>

            <div className="pt-1">
              <h2 className="text-center font-bold uppercase text-xs mb-2">
                REQUISITION
              </h2>
              <div className="border border-black">
                <table className="w-full table-fixed border-collapse text-[10px]">
                  <thead>
                    <tr className="border-b border-black text-center font-bold">
                      <th className="w-[12%] border-r border-black px-1 py-2">
                        ITEM/ NUMBER
                      </th>
                      <th className="w-[9%] border-r border-black px-1 py-2">
                        QTY
                      </th>
                      <th className="w-[11%] border-r border-black px-1 py-2">
                        UNIT
                      </th>
                      <th className="w-[31%] border-r border-black px-1 py-2">
                        ITEM DESCRIPTION
                      </th>
                      <th className="w-[18%] border-r border-black px-1 py-2">
                        ESTIMATED UNIT COST
                      </th>
                      <th className="w-[19%] px-1 py-2">ESTIMATED AMOUNT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prItems.map((row) => {
                      const amount = row.qty * row.unitCost;
                      return (
                        <tr key={row.id} className="border-b border-black">
                          <td className="border-r border-black px-1 py-2.5 text-center">
                            <InlineEditable
                              value={row.itemNo}
                              onChange={(v) => {
                                const next = prItems.map((item) =>
                                  item.id === row.id ? { ...item, itemNo: v } : item
                                );
                                setPrItems(next);
                                syncCurrentPrRecord(next);
                              }}
                            />
                          </td>
                          <td className="border-r border-black px-1 py-2.5 text-center">
                            <InlineEditable
                              value={row.qty ? String(row.qty) : ''}
                              onChange={(v) => {
                                const next = prItems.map((item) =>
                                  item.id === row.id
                                    ? { ...item, qty: Number(v) || 0 }
                                    : item
                                );
                                setPrItems(next);
                                syncCurrentPrRecord(next);
                              }}
                            />
                          </td>
                          <td className="border-r border-black px-1 py-2.5 text-center">
                            <InlineEditable
                              value={row.unit}
                              onChange={(v) => {
                                const next = prItems.map((item) =>
                                  item.id === row.id ? { ...item, unit: v } : item
                                );
                                setPrItems(next);
                                syncCurrentPrRecord(next);
                              }}
                            />
                          </td>
                          <td className="border-r border-black px-1 py-2.5 break-words">
                            <InlineEditable
                              value={row.description}
                              onChange={(v) => {
                                const next = prItems.map((item) =>
                                  item.id === row.id
                                    ? { ...item, description: v }
                                    : item
                                );
                                setPrItems(next);
                                syncCurrentPrRecord(next);
                              }}
                            />
                          </td>
                          <td className="border-r border-black px-1 py-2.5 text-right">
                            <InlineEditable
                              value={row.unitCost ? formatNumber(row.unitCost) : ''}
                              onChange={(v) => {
                                const next = prItems.map((item) =>
                                  item.id === row.id
                                    ? {
                                        ...item,
                                        unitCost: Number(v.replace(/,/g, '')) || 0,
                                      }
                                    : item
                                );
                                setPrItems(next);
                                syncCurrentPrRecord(next);
                              }}
                            />
                          </td>
                          <td className="px-1 py-2.5 text-right">
                            {amount ? formatNumber(amount) : ''}
                          </td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: blankCount }).map((_, idx) => (
                      <tr key={`pr-blank-${idx}`} className="border-b border-black">
                        {Array.from({ length: 6 }).map((__, cell) => (
                          <td
                            key={cell}
                            className={`${cell < 5 ? 'border-r border-black' : ''} py-3.5`}
                          >
                            &nbsp;
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="grid grid-cols-12 border-b border-black text-[11px]">
                  <div className="col-span-9 border-r border-black px-2 py-1.5 font-bold">
                    Amount in Words:{' '}
                    <span className="uppercase">
                      {prTotal ? amountToPesoWords(prTotal) : ''}
                    </span>
                  </div>
                  <div className="col-span-3 px-2 py-1.5 font-bold">Php</div>
                </div>

                <div className="px-2 py-1.5 text-[11px] font-bold">
                  Purpose:{' '}
                  <span className="font-normal">
                    <InlineEditable
                      value={prPurpose}
                      onChange={(v) => {
                        setPrPurpose(v);
                        syncCurrentPrRecord(prItems, prFormDate, v);
                      }}
                    />
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-10 pt-10 text-[11px]">
              <div>
                <p>Requested by:</p>
                <div className="mt-10 text-center">
                  <p className="font-bold uppercase">{prRequestedBy}</p>
                  <p>{prRequestedRole}</p>
                  <p className="pt-2 underline">{prFormDate}</p>
                  <p>Date</p>
                </div>
              </div>
              <div>
                <p>Approved by:</p>
                <div className="mt-10 text-center">
                  <p className="font-bold uppercase">{prApprovedBy}</p>
                  <p>SK Chairperson</p>
                  <p className="pt-2 underline">{prFormDate}</p>
                  <p>Date</p>
                </div>
              </div>
            </div>
          </div>
        );
      }

      case 'rfq': {
        const blankCount = Math.max(0, 1 - rfqItems.length);
        return (
          <div className="w-full max-w-full overflow-hidden text-xs text-slate-950 space-y-3">
            {renderBarangayHeader('REQUEST FOR QUOTATION')}

            <div className="flex justify-between gap-4 text-[11px]">
              <p>
                Purchase Request Number:{' '}
                <strong className="underline">{rfqPrNo}</strong>
              </p>
              <p>
                Date:{' '}
                <span className="inline-block min-w-28 border-b border-black">
                  <InlineEditable
                    value={rfqDate}
                    onChange={(v) => setRfqDate(formatAutoDashDate(v))}
                  />
                </span>
              </p>
            </div>

            <div className="space-y-3 pt-1 text-[11px]">
              <div>
                <span className="inline-block w-72 border-b border-black">
                  <InlineEditable
                    value={rfqDealer}
                    onChange={setRfqDealer}
                    placeholder=" "
                  />
                </span>
                <p className="w-72 text-center">(Dealer)</p>
              </div>
              <div>
                <span className="inline-block w-72 border-b border-black">
                  <InlineEditable
                    value={rfqAddress}
                    onChange={setRfqAddress}
                    placeholder=" "
                  />
                </span>
                <p className="w-72 text-center">(Address)</p>
              </div>
            </div>

            <div className="text-[11px] leading-snug pt-1">
              <p className="uppercase">SIR/MA’AM:</p>
              <p className="mt-1 pl-6 text-left">
                Please quote the article issued listed hereunder with its
                corresponding specification FOD{' '}
                <span className="inline-block min-w-24 border-b border-black">
                  <InlineEditable
                    value={rfqFod}
                    onChange={setRfqFod}
                    placeholder=" "
                  />
                </span>{' '}
                stated in your Quotation the shortest time of delivery from the
                receipts of Purchase Order. If available, please furnish
                catalogues, description brochures or other literature about the
                articles. In case you do not have items specified as called for,
                feel free to offer such a product which you are now having in
                stock, provided that the same is the equivalent of what is
                desired. If you are the manufacturer or exclusive distributor of
                these articles in this City, please indicate in your quotation.
                State also how long your quotation will remain effective. Deposit
                your quotations in an envelope and seal it securely as send it to
                Barangay Kauswagan. Mark the said envelope.
              </p>
            </div>

            <div className="grid grid-cols-12 items-end gap-2 pt-2 text-[11px]">
              <div className="col-span-6">
                PROPOSAL/ QUOTATION:{' '}
                <strong className="underline">
                  <InlineEditable value={rfqProposal} onChange={setRfqProposal} />
                </strong>
              </div>
              <div className="col-span-6 text-center">
                <p className="font-bold uppercase">{rfqBacChair}</p>
                <p className="font-bold uppercase">SK BAC CHAIRMAN</p>
              </div>
            </div>

            <table className="w-full table-fixed border-collapse border border-black text-[10px]">
              <thead>
                <tr className="border-b border-black text-center font-bold">
                  <th className="w-[12%] border-r border-black px-1 py-1.5">
                    ITEM/ NUMBER
                  </th>
                  <th className="w-[9%] border-r border-black px-1 py-1.5">
                    QTY
                  </th>
                  <th className="w-[10%] border-r border-black px-1 py-1.5">
                    UNIT
                  </th>
                  <th className="w-[35%] border-r border-black px-1 py-1.5">
                    ITEM DESCRIPTION
                  </th>
                  <th className="w-[17%] border-r border-black px-1 py-1.5">
                    ESTIMATED UNIT COST
                  </th>
                  <th className="w-[17%] px-1 py-1.5">ESTIMATED AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {rfqItems.map((row) => (
                  <tr key={row.id} className="border-b border-black">
                    <td className="border-r border-black px-1 py-2.5 text-center">
                      {row.itemNo}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 text-center">
                      {row.qty || ''}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 text-center">
                      {row.unit}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 break-words">
                      {row.description}
                    </td>
                    <td className="border-r border-black px-1 py-2.5">&nbsp;</td>
                    <td className="px-1 py-2.5">&nbsp;</td>
                  </tr>
                ))}
                {Array.from({ length: blankCount }).map((_, idx) => (
                  <tr key={`rfq-blank-${idx}`} className="border-b border-black">
                    {Array.from({ length: 6 }).map((__, cell) => (
                      <td
                        key={cell}
                        className={`${cell < 5 ? 'border-r border-black' : ''} py-3`}
                      >
                        &nbsp;
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td
                    colSpan={4}
                    className="border-r border-black px-2 py-1.5"
                  >
                    &nbsp;
                  </td>
                  <td className="border-r border-black px-2 py-1.5 text-right font-bold">
                    Total:
                  </td>
                  <td className="px-1 py-1.5">&nbsp;</td>
                </tr>
              </tbody>
            </table>

            <div className="pt-2 text-[11px] leading-relaxed">
              <p>
                Delivery will be{' '}
                <span className="inline-block min-w-28 border-b border-black">
                  <InlineEditable
                    value={rfqDeliveryWillBe}
                    onChange={setRfqDeliveryWillBe}
                    placeholder=" "
                  />
                </span>{' '}
                FOB{' '}
                <span className="inline-block min-w-28 border-b border-black">
                  <InlineEditable
                    value={rfqFob}
                    onChange={setRfqFob}
                    placeholder=" "
                  />
                </span>{' '}
                is not the exclusive dealer or manufacturer of the article
                specified above, in the City of Cagayan de Oro, the above prices
                quoted are good items/unit{' '}
                <span className="inline-block min-w-24 border-b border-black">
                  <InlineEditable
                    value={rfqGoodItemsUnitYear}
                    onChange={setRfqGoodItemsUnitYear}
                    placeholder=" "
                  />
                </span>{' '}
                2024.
              </p>

              <div className="pt-10 flex justify-end">
                <div className="w-60 text-center">
                  <p className="text-left font-bold">Very truly yours,</p>
                  <p className="mt-10 border-b border-black">&nbsp;</p>
                  <p className="pt-0.5">Printed Name &amp; Signature</p>
                  <p className="mt-2 text-left">Date:</p>
                </div>
              </div>
            </div>
          </div>
        );
      }

      case 'abstract': {
        const blankCount = Math.max(0, 3 - absRows.length);
        const topCommitteeRow = [
          [absBacChair, 'SK BAC CHAIRPERSON'],
          [absBacViceChair, 'SK BAC VICE-CHAIRPERSON'],
          [absBacSec, 'BAC SECRETARIAT'],
          [absMem1, 'BAC MEMBER'],
        ];
        const bottomCommitteeRow = [
          [absMem2, 'BAC MEMBER'],
          [absMem3, 'BAC MEMBER'],
          [absMem4, 'BAC MEMBER'],
          [absMem5, 'BAC MEMBER'],
        ];

        return (
          <div className="w-full max-w-full overflow-hidden text-xs text-slate-950 space-y-2.5">
            {renderBarangayHeader('ABSTRACT OF QUOTATION')}

            <div className="grid grid-cols-12 gap-2 text-[10px] font-bold">
              <div className="col-span-7 space-y-0.5">
                <p>
                  ABSTRACT OF PROPOSAL:{' '}
                  <span className="underline">
                    <InlineEditable
                      value={absProposal}
                      onChange={setAbsProposal}
                    />
                  </span>
                </p>
                <p>
                  PER P.R NO:{' '}
                  <span className="underline">
                    <InlineEditable value={absPrNo} onChange={setAbsPrNo} />
                  </span>
                </p>
              </div>
              <div className="col-span-5 space-y-0.5">
                <p>
                  DATED:{' '}
                  <span className="underline">
                    <InlineEditable
                      value={absDated}
                      onChange={(v) => setAbsDated(formatAutoDashDate(v))}
                    />
                  </span>
                </p>
                <p>
                  DATE/TIME OPENED:{' '}
                  <InlineEditable
                    value={absOpened}
                    onChange={setAbsOpened}
                    placeholder=" "
                  />
                </p>
              </div>
            </div>

            <table className="w-full table-fixed border-collapse border border-black text-[9px]">
              <thead>
                <tr className="border-b border-black text-center font-bold">
                  <th
                    colSpan={4}
                    className="border-r border-black px-1 py-1.5"
                  >
                    &nbsp;
                  </th>
                  <th colSpan={3} className="px-1 py-1.5">
                    PROPOSAL AND/OR PRICE QUOTATION OF BIDDERS
                  </th>
                </tr>
                <tr className="border-b border-black text-center font-bold">
                  <th className="w-[9%] border-r border-black px-1 py-1.5">
                    ITEM NO.
                  </th>
                  <th className="w-[8%] border-r border-black px-1 py-1.5">
                    QTY.
                  </th>
                  <th className="w-[9%] border-r border-black px-1 py-1.5">
                    UNIT
                  </th>
                  <th className="w-[26%] border-r border-black px-1 py-1.5">
                    DESCRIPTION
                  </th>
                  <th className="w-[16%] border-r border-black px-1 py-1.5">
                    {absEntity1 || 'NAME OF ENTITY'}
                  </th>
                  <th className="w-[16%] border-r border-black px-1 py-1.5">
                    {absEntity2 || 'NAME OF ENTITY'}
                  </th>
                  <th className="w-[16%] px-1 py-1.5">
                    {absEntity3 || 'NAME OF ENTITY'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {absRows.map((row) => (
                  <tr key={row.id} className="border-b border-black">
                    <td className="border-r border-black px-1 py-2.5 text-center">
                      {row.itemNo}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 text-center">
                      {row.qty || ''}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 text-center">
                      {row.unit}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 break-words">
                      {row.description}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 text-right">
                      {row.bid1 ? formatNumber(row.bid1) : ''}
                    </td>
                    <td className="border-r border-black px-1 py-2.5 text-right">
                      {row.bid2 ? formatNumber(row.bid2) : ''}
                    </td>
                    <td className="px-1 py-2.5 text-right">
                      {row.bid3 ? formatNumber(row.bid3) : ''}
                    </td>
                  </tr>
                ))}
                {Array.from({ length: blankCount }).map((_, idx) => (
                  <tr key={`abs-blank-${idx}`} className="border-b border-black">
                    {Array.from({ length: 7 }).map((__, cell) => (
                      <td
                        key={cell}
                        className={`${cell < 6 ? 'border-r border-black' : ''} py-3.5`}
                      >
                        &nbsp;
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="text-[10px] leading-snug text-left pt-1">
              We hereby certify that at the time, place and date indicated above,
              we opened the bids for the above listed equipment/supplies and the
              above is the true and correct abstract thereof. We further certify
              that the lowest price offered by the different bidders is indicated
              by means of checks marks. The provisions of the FLAG LAW have been
              applied.
            </p>

            <div className="grid grid-cols-12 gap-2 pt-5 text-[9px] font-bold">
              <div className="col-span-4 text-center">
                <p className="inline-block border-b border-black pb-0.5 uppercase">
                  {absForwardedBy}
                </p>
                <p className="pt-0.5">APPROVED FORWARDED</p>
              </div>
              <div className="col-span-4">
                <p>WINNING BIDDER:</p>
                <p className="pl-6 uppercase break-words">{absWinner}</p>
              </div>
              <div className="col-span-4 text-center">
                <p className="inline-block border-b border-black pb-0.5 uppercase">
                  {absActionBy}
                </p>
                <p className="pt-0.5">ACTION COMMITTEE TAKEN</p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-x-3 gap-y-4 pt-6 text-center text-[8px]">
              {topCommitteeRow.map(([name, role], idx) => (
                <div key={`abs-top-${idx}`} className="min-w-0">
                  <p className="inline-block border-b border-black pb-0.5 uppercase break-words">
                    {name}
                  </p>
                  <p className="pt-0.5">{role}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-4 gap-x-3 gap-y-4 pt-3 text-center text-[8px]">
              {bottomCommitteeRow.map(([name, role], idx) => (
                <div key={`abs-bot-${idx}`} className="min-w-0">
                  <p className="inline-block border-b border-black pb-0.5 uppercase break-words">
                    {name}
                  </p>
                  <p className="pt-0.5">{role}</p>
                </div>
              ))}
            </div>
          </div>
        );
      }

      case 'po': {
        return (
          <div className="w-full max-w-full overflow-hidden text-xs text-slate-950">
            <h1 className="text-center text-sm font-bold uppercase mb-3">
              PURCHASE ORDER
            </h1>

            <div className="border border-black text-[10px]">
              <div className="grid grid-cols-12 border-b border-black">
                <div className="col-span-6 px-2 py-1.5 font-bold">
                  Barangay: <span>KAUSWAGAN</span>
                </div>
                <div className="col-span-6 px-2 py-1.5">
                  <p>
                    City/Municipality: <strong>CAGAYAN DE ORO</strong>
                  </p>
                  <p>
                    Province: <strong>MISAMIS ORIENTAL</strong>
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black">
                <div className="col-span-6 px-2 py-1.5 space-y-1">
                  <p>
                    Supplier: <strong>{poSupplier}</strong>
                  </p>
                  <p>
                    Address: <strong>{poAddress}</strong>
                  </p>
                  <p>
                    TIN: <strong>{poTin}</strong>
                  </p>
                </div>
                <div className="col-span-6 px-2 py-1.5 space-y-1">
                  <p>
                    PO No.: <strong>{poNumber}</strong>
                  </p>
                  <p>
                    Date: <strong>{poDate}</strong>
                  </p>
                  <p>Mode of Procurement:</p>
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    {(
                      ['Shopping', 'Negotiated', 'Over the Counter'] as const
                    ).map((mode) => (
                      <span
                        key={mode}
                        className="inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        <span className="inline-flex h-3 w-3 items-center justify-center text-[10px] font-bold">
                          {poMode === mode ? '✓' : ''}
                        </span>
                        {mode}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="border-b border-black px-2 py-1.5 leading-snug">
                <p>Gentlemen:</p>
                <p className="pl-5">
                  Please deliver to this office the following articles subject to
                  the terms and conditions contained herein.
                </p>
              </div>

              <div className="grid grid-cols-12 border-b border-black px-2 py-1.5">
                <div className="col-span-6 space-y-1">
                  <p>
                    Place of delivery:{' '}
                    <span className="underline">
                      <InlineEditable
                        value={poDeliveryPlace}
                        onChange={setPoDeliveryPlace}
                      />
                    </span>
                  </p>
                  <p>
                    Date of delivery:{' '}
                    <span className="underline">
                      <InlineEditable
                        value={poDeliveryDate}
                        onChange={setPoDeliveryDate}
                      />
                    </span>
                  </p>
                </div>
                <div className="col-span-6 space-y-1">
                  <p>
                    Delivery Term:{' '}
                    <span className="inline-block min-w-28 border-b border-black">
                      <InlineEditable
                        value={poDeliveryTerm}
                        onChange={setPoDeliveryTerm}
                        placeholder=" "
                      />
                    </span>
                  </p>
                  <p>
                    Payment Term:{' '}
                    <span className="inline-block min-w-28 border-b border-black">
                      <InlineEditable
                        value={poPaymentTerm}
                        onChange={setPoPaymentTerm}
                        placeholder=" "
                      />
                    </span>
                  </p>
                </div>
              </div>

              <table className="w-full table-fixed border-collapse text-[10px]">
                <thead>
                  <tr className="border-b border-black text-center font-bold">
                    <th className="w-[15%] border-r border-black px-1 py-1.5">
                      UNIT
                    </th>
                    <th className="w-[37%] border-r border-black px-1 py-1.5">
                      PARTICULARS
                    </th>
                    <th className="w-[16%] border-r border-black px-1 py-1.5">
                      QUANTITY
                    </th>
                    <th className="w-[16%] border-r border-black px-1 py-1.5">
                      UNIT COST
                    </th>
                    <th className="w-[16%] px-1 py-1.5">AMOUNT</th>
                  </tr>
                </thead>
                <tbody>
                  {poItems.map((row) => {
                    const amount = row.qty * row.unitCost;
                    return (
                      <tr key={row.id} className="border-b border-black">
                        <td className="border-r border-black px-1 py-2 text-center">
                          {row.unit}
                        </td>
                        <td className="border-r border-black px-1 py-2 text-center break-words">
                          {row.description}
                        </td>
                        <td className="border-r border-black px-1 py-2 text-center">
                          {row.qty || ''}
                        </td>
                        <td className="border-r border-black px-1 py-2 text-right">
                          {row.unitCost ? formatNumber(row.unitCost) : ''}
                        </td>
                        <td className="px-1 py-2 text-right">
                          {amount ? formatNumber(amount) : ''}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-b border-black font-bold">
                    <td className="border-r border-black py-2">&nbsp;</td>
                    <td className="border-r border-black py-2">&nbsp;</td>
                    <td className="border-r border-black py-2">&nbsp;</td>
                    <td className="border-r border-black px-2 py-2 text-right">
                      TOTAL
                    </td>
                    <td className="px-2 py-2 text-center">
                      Php {poTotal ? formatNumber(poTotal) : ''}
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="border-b border-black px-2 py-2 leading-snug">
                <p>
                  In case of failure to make full delivery within the time
                  specified above, a penalty of one-tenth (1/10) of one percent
                  for every day of delay shall be imposed.
                </p>
                <div className="pt-6 flex justify-end">
                  <div className="w-60 text-center">
                    <p className="text-left">Very truly yours,</p>
                    <p className="mt-10 inline-block border-b border-black pb-0.5 uppercase">
                      {poChair}
                    </p>
                    <p>{poChairRole}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-12 text-[10px]">
                <div className="col-span-6 border-r border-black p-2">
                  <p>Conforme:</p>
                  <div className="mt-10 text-center">
                    <p className="inline-block border-b border-black pb-0.5 uppercase">
                      <InlineEditable
                        value={poConforme}
                        onChange={setPoConforme}
                      />
                    </p>
                    <p>(Signature over Printed Name)</p>
                    <p>Supplier</p>
                    <p className="mx-auto mt-6 w-48 border-b border-black">
                      &nbsp;
                    </p>
                    <p>Date</p>
                  </div>
                </div>
                <div className="col-span-6 p-2">
                  <p>Existence of Availability Appropriations of</p>
                  <p className="pt-4 text-center">Date</p>
                  <div className="mt-4 text-center">
                    <p className="inline-block border-b border-black pb-0.5 uppercase">
                      {poBudgetOfficer}
                    </p>
                    <p>(Signature over Printed Name)</p>
                    <p>Budget Monitoring Officer</p>
                    <p className="mx-auto mt-6 w-48 border-b border-black">
                      &nbsp;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }

      case 'iar': {
        return (
          <div className="w-full max-w-full overflow-hidden text-xs text-slate-950">
            <h1 className="text-center text-sm font-bold uppercase mb-4">
              INSPECTION AND ACCEPTANCE REPORT
            </h1>

            <div className="border border-black text-[10px]">
              <div className="border-b border-black p-2 space-y-0.5 leading-snug">
                <p>
                  Barangay: <strong>Kauswagan</strong>
                </p>
                <p>
                  City/Municipality: <strong>Cagayan de Oro City</strong>
                </p>
                <p>
                  Province: <strong>Misamis Oriental</strong>
                </p>
              </div>

              <div className="grid grid-cols-12 gap-2 border-b border-black p-2">
                <div className="col-span-5 space-y-2">
                  <p>
                    Supplier:{' '}
                    <InlineEditable
                      value={iarSupplier}
                      onChange={setIarSupplier}
                    />
                  </p>
                  <p>
                    Address:{' '}
                    <InlineEditable
                      value={iarAddress}
                      onChange={setIarAddress}
                    />
                  </p>
                  <p>
                    P.O No:{' '}
                    <strong>
                      <InlineEditable value={iarPoNo} onChange={setIarPoNo} />
                    </strong>
                  </p>
                </div>
                <div className="col-span-7 space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <p>
                      Invoice No.:{' '}
                      <InlineEditable
                        value={iarInvoiceNo}
                        onChange={setIarInvoiceNo}
                      />
                    </p>
                    <p>
                      AIR No.:{' '}
                      <InlineEditable value={iarAirNo} onChange={setIarAirNo} />
                    </p>
                    <p>
                      CNTRL/RIS No.:{' '}
                      <InlineEditable value={iarRisNo} onChange={setIarRisNo} />
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <p>
                      Invoice Date:{' '}
                      <InlineEditable
                        value={iarInvoiceDate}
                        onChange={(v) =>
                          setIarInvoiceDate(formatAutoDashDate(v))
                        }
                      />
                    </p>
                    <p>
                      Date:{' '}
                      <InlineEditable
                        value={iarAirDate}
                        onChange={(v) => setIarAirDate(formatAutoDashDate(v))}
                      />
                    </p>
                    <p>
                      Date:{' '}
                      <InlineEditable
                        value={iarRisDate}
                        onChange={(v) => setIarRisDate(formatAutoDashDate(v))}
                      />
                    </p>
                  </div>
                </div>
              </div>

              <table className="w-full table-fixed border-collapse text-[10px]">
                <thead>
                  <tr className="border-b border-black text-center font-bold">
                    <th className="w-[24%] border-r border-black px-1 py-1.5">
                      UNIT
                    </th>
                    <th className="w-[46%] border-r border-black px-1 py-1.5">
                      DESCRIPTION
                    </th>
                    <th className="w-[30%] px-1 py-1.5">QUANTITY</th>
                  </tr>
                </thead>
                <tbody>
                  {iarItems.map((row) => (
                    <tr key={row.id} className="border-b border-black">
                      <td className="border-r border-black px-1 py-3 text-center">
                        {row.unit}
                      </td>
                      <td className="border-r border-black px-1 py-3 break-words">
                        {row.description}
                      </td>
                      <td className="px-1 py-3 text-center">
                        {row.qty || ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="grid grid-cols-2 border-b border-black text-center text-[10px] font-bold">
                <div className="border-r border-black py-1.5">INSPECTION</div>
                <div className="py-1.5">ACCEPTANCE</div>
              </div>

              <div className="grid grid-cols-2 text-[10px]">
                <div className="border-r border-black p-2.5 space-y-5">
                  <p>
                    Date Inspected:{' '}
                    <span className="inline-block min-w-24 border-b border-black">
                      <InlineEditable
                        value={iarDateInspected}
                        onChange={(v) =>
                          setIarDateInspected(formatAutoDashDate(v))
                        }
                      />
                    </span>
                  </p>
                  <div className="flex items-start gap-2.5 pl-2">
                    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-black text-[8px] text-white">
                      •
                    </span>
                    <span className="font-bold leading-snug">
                      Inspected, verified and found Ok to quantity and
                      specifications
                    </span>
                  </div>
                  <div className="pt-10 text-center">
                    <p className="inline-block border-b border-black pb-0.5 font-bold uppercase">
                      {iarTreasurer}
                    </p>
                    <p>SK Treasurer</p>
                  </div>
                </div>

                <div className="p-2.5 space-y-5">
                  <p>
                    Date Received:{' '}
                    <span className="inline-block min-w-24 border-b border-black">
                      <InlineEditable
                        value={iarDateReceived}
                        onChange={(v) =>
                          setIarDateReceived(formatAutoDashDate(v))
                        }
                      />
                    </span>
                  </p>
                  <div className="space-y-1.5 pl-4 font-bold">
                    <p className="flex items-center gap-2">
                      <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-xs">
                        {iarStatus === 'Complete' ? '•' : '◦'}
                      </span>
                      Complete
                    </p>
                    <p className="flex items-center gap-2">
                      <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-xs">
                        {iarStatus === 'Partial' ? '•' : '◦'}
                      </span>
                      Partial
                    </p>
                  </div>
                  <div className="pt-10 text-center">
                    <p className="inline-block border-b border-black pb-0.5 font-bold uppercase">
                      {iarInspector}
                    </p>
                    <p>Inspection Officer</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }
    }
  };

  const renderRecordDocumentPreview = (rec: ProcurementDbRecord) => {
    const p = rec.payload;
    const docType = p?.activeTab || rec.docType;
    const recPaperSize: PaperSizeKey = p?.paperSize || 'a4';
    const recOrientation: PaperOrientation = p?.orientation || 'portrait';
    const spec = PAPER_DIMENSIONS[recPaperSize];
    const widthMm =
      recOrientation === 'portrait' ? spec.widthMm : spec.heightMm;
    const minHeightMm =
      recOrientation === 'portrait' ? spec.heightMm : spec.widthMm;

    const renderPreviewInner = () => {
      if (docType === 'pr') {
        const items = Array.isArray(p?.prItems) ? p.prItems : [];
        const total = items.reduce((s, r) => s + r.qty * r.unitCost, 0);
        const blanks = Math.max(0, 3 - items.length);
        const prDateDisplay = p?.prFormDate || rec.dateText || '';
        return (
          <div className="text-xs text-slate-950 space-y-4">
            <h1 className="text-center text-sm font-bold uppercase tracking-wide">
              PURCHASE REQUEST
            </h1>
            <div className="grid grid-cols-12 gap-x-3 gap-y-0.5 text-[11px]">
              <div className="col-span-7">
                Barangay: <strong>Kauswagan</strong>
              </div>
              <div className="col-span-5">
                P.R No.: <strong>{p?.prFormNo || rec.finalId}</strong>
              </div>
              <div className="col-span-7">
                City/Municipality: <strong>Cagayan De Oro</strong>
              </div>
              <div className="col-span-5">
                Date: <strong className="underline">{prDateDisplay}</strong>
              </div>
              <div className="col-span-7">
                Province: <strong>Misamis Oriental</strong>
              </div>
            </div>
            <div>
              <h2 className="text-center font-bold uppercase text-xs mb-2">
                REQUISITION
              </h2>
              <div className="border border-black">
                <table className="w-full table-fixed border-collapse text-[10px]">
                  <thead>
                    <tr className="border-b border-black text-center font-bold">
                      <th className="w-[12%] border-r border-black px-1 py-1.5">
                        ITEM/ NUMBER
                      </th>
                      <th className="w-[9%] border-r border-black px-1 py-1.5">
                        QTY
                      </th>
                      <th className="w-[11%] border-r border-black px-1 py-1.5">
                        UNIT
                      </th>
                      <th className="w-[31%] border-r border-black px-1 py-1.5">
                        ITEM DESCRIPTION
                      </th>
                      <th className="w-[18%] border-r border-black px-1 py-1.5">
                        ESTIMATED UNIT COST
                      </th>
                      <th className="w-[19%] px-1 py-1.5">ESTIMATED AMOUNT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr key={row.id} className="border-b border-black">
                        <td className="border-r border-black px-1 py-2 text-center">
                          {row.itemNo}
                        </td>
                        <td className="border-r border-black px-1 py-2 text-center">
                          {row.qty || ''}
                        </td>
                        <td className="border-r border-black px-1 py-2 text-center">
                          {row.unit}
                        </td>
                        <td className="border-r border-black px-1 py-2 break-words">
                          {row.description}
                        </td>
                        <td className="border-r border-black px-1 py-2 text-right">
                          {row.unitCost ? formatNumber(row.unitCost) : ''}
                        </td>
                        <td className="px-1 py-2 text-right">
                          {row.qty * row.unitCost
                            ? formatNumber(row.qty * row.unitCost)
                            : ''}
                        </td>
                      </tr>
                    ))}
                    {Array.from({ length: blanks }).map((_, idx) => (
                      <tr key={`pv-pr-${idx}`} className="border-b border-black">
                        {Array.from({ length: 6 }).map((__, cell) => (
                          <td
                            key={cell}
                            className={`${cell < 5 ? 'border-r border-black' : ''} py-3`}
                          >
                            &nbsp;
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="grid grid-cols-12 border-b border-black text-[11px]">
                  <div className="col-span-9 border-r border-black px-2 py-1 font-bold">
                    Amount in Words:{' '}
                    <span className="uppercase">
                      {total ? amountToPesoWords(total) : ''}
                    </span>
                  </div>
                  <div className="col-span-3 px-2 py-1 font-bold">Php</div>
                </div>
                <div className="px-2 py-1 text-[11px] font-bold">
                  Purpose:{' '}
                  <span className="font-normal">
                    {p?.prPurpose || rec.title}
                  </span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-10 pt-8 text-[11px]">
              <div>
                <p>Requested by:</p>
                <div className="mt-8 text-center">
                  <p className="font-bold uppercase">
                    {p?.prRequestedBy || ''}
                  </p>
                  <p>{p?.prRequestedRole || 'Requesting Officer'}</p>
                  <p className="pt-2 underline">{prDateDisplay}</p>
                  <p>Date</p>
                </div>
              </div>
              <div>
                <p>Approved by:</p>
                <div className="mt-8 text-center">
                  <p className="font-bold uppercase">{FIXED_SK_CHAIRPERSON}</p>
                  <p>SK Chairperson</p>
                  <p className="pt-2 underline">{prDateDisplay}</p>
                  <p>Date</p>
                </div>
              </div>
            </div>
          </div>
        );
      }

      if (docType === 'rfq') {
        const items = Array.isArray(p?.rfqItems) ? p.rfqItems : [];
        const blanks = Math.max(0, 1 - items.length);
        return (
          <div className="text-xs text-slate-950 space-y-2.5">
            {renderBarangayHeader('REQUEST FOR QUOTATION')}
            <div className="flex justify-between text-[11px]">
              <p>
                Purchase Request Number:{' '}
                <strong className="underline">{p?.rfqPrNo || '—'}</strong>
              </p>
              <p>
                Date:{' '}
                <span className="inline-block min-w-24 border-b border-black">
                  {p?.rfqDate || rec.dateText || ''}
                </span>
              </p>
            </div>
            <div className="space-y-2 text-[11px]">
              <div>
                <span className="inline-block w-64 border-b border-black">
                  {p?.rfqDealer || rec.title}
                </span>
                <p className="w-64 text-center">(Dealer)</p>
              </div>
              <div>
                <span className="inline-block w-64 border-b border-black">
                  {p?.rfqAddress || ''}
                </span>
                <p className="w-64 text-center">(Address)</p>
              </div>
            </div>
            <p className="text-[10px] leading-snug">
              <strong>SIR/MA’AM:</strong> Please quote the article issued listed
              hereunder with its corresponding specification FOD{' '}
              <span className="underline">{p?.rfqFod || '______'}</span> stated
              in your Quotation the shortest time of delivery from the receipts
              of Purchase Order.
            </p>
            <div className="grid grid-cols-12 items-end text-[10px]">
              <div className="col-span-6">
                PROPOSAL/ QUOTATION:{' '}
                <strong className="underline">{p?.rfqProposal || ''}</strong>
              </div>
              <div className="col-span-6 text-center">
                <p className="font-bold uppercase">
                  {p?.rfqBacChair || FIXED_ABS_BAC_CHAIR}
                </p>
                <p className="font-bold">SK BAC CHAIRMAN</p>
              </div>
            </div>
            <table className="w-full table-fixed border-collapse border border-black text-[10px]">
              <thead>
                <tr className="border-b border-black text-center font-bold">
                  <th className="w-[12%] border-r border-black px-1 py-1">
                    ITEM/ NUMBER
                  </th>
                  <th className="w-[9%] border-r border-black px-1 py-1">
                    QTY
                  </th>
                  <th className="w-[10%] border-r border-black px-1 py-1">
                    UNIT
                  </th>
                  <th className="w-[35%] border-r border-black px-1 py-1">
                    ITEM DESCRIPTION
                  </th>
                  <th className="w-[17%] border-r border-black px-1 py-1">
                    ESTIMATED UNIT COST
                  </th>
                  <th className="w-[17%] px-1 py-1">ESTIMATED AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-b border-black">
                    <td className="border-r border-black px-1 py-2 text-center">
                      {row.itemNo}
                    </td>
                    <td className="border-r border-black px-1 py-2 text-center">
                      {row.qty || ''}
                    </td>
                    <td className="border-r border-black px-1 py-2 text-center">
                      {row.unit}
                    </td>
                    <td className="border-r border-black px-1 py-2 break-words">
                      {row.description}
                    </td>
                    <td className="border-r border-black px-1 py-2">&nbsp;</td>
                    <td className="px-1 py-2">&nbsp;</td>
                  </tr>
                ))}
                {Array.from({ length: blanks }).map((_, idx) => (
                  <tr key={`pv-rfq-${idx}`} className="border-b border-black">
                    {Array.from({ length: 6 }).map((__, cell) => (
                      <td
                        key={cell}
                        className={`${cell < 5 ? 'border-r border-black' : ''} py-3`}
                      >
                        &nbsp;
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="border-r border-black px-1 py-1">
                    &nbsp;
                  </td>
                  <td className="border-r border-black px-1 py-1 text-right font-bold">
                    Total:
                  </td>
                  <td className="px-1 py-1">&nbsp;</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      }

      if (docType === 'abstract') {
        const rows = Array.isArray(p?.absRows) ? p.absRows : [];
        return (
          <div className="text-xs text-slate-950 space-y-2">
            {renderBarangayHeader('ABSTRACT OF QUOTATION')}
            <div className="grid grid-cols-12 gap-2 text-[10px] font-bold">
              <div className="col-span-7 space-y-0.5">
                <p>
                  ABSTRACT OF PROPOSAL:{' '}
                  <span className="underline">
                    {p?.absProposal || rec.title}
                  </span>
                </p>
                <p>
                  PER P.R NO:{' '}
                  <span className="underline">{p?.absPrNo || ''}</span>
                </p>
              </div>
              <div className="col-span-5 space-y-0.5">
                <p>
                  DATED:{' '}
                  <span className="underline">
                    {p?.absDated || rec.dateText || ''}
                  </span>
                </p>
                <p>DATE/TIME OPENED: {p?.absOpened || ''}</p>
              </div>
            </div>
            <table className="w-full table-fixed border-collapse border border-black text-[9px]">
              <thead>
                <tr className="border-b border-black text-center font-bold">
                  <th
                    colSpan={4}
                    className="border-r border-black px-1 py-1"
                  >
                    &nbsp;
                  </th>
                  <th colSpan={3} className="px-1 py-1">
                    PROPOSAL AND/OR PRICE QUOTATION OF BIDDERS
                  </th>
                </tr>
                <tr className="border-b border-black text-center font-bold">
                  <th className="border-r border-black px-1 py-1">ITEM NO.</th>
                  <th className="border-r border-black px-1 py-1">QTY.</th>
                  <th className="border-r border-black px-1 py-1">UNIT</th>
                  <th className="border-r border-black px-1 py-1">
                    DESCRIPTION
                  </th>
                  <th className="border-r border-black px-1 py-1">
                    {p?.absEntity1 || 'NAME OF ENTITY'}
                  </th>
                  <th className="border-r border-black px-1 py-1">
                    {p?.absEntity2 || 'NAME OF ENTITY'}
                  </th>
                  <th className="px-1 py-1">
                    {p?.absEntity3 || 'NAME OF ENTITY'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-black">
                    <td className="border-r border-black px-1 py-1.5 text-center">
                      {r.itemNo}
                    </td>
                    <td className="border-r border-black px-1 py-1.5 text-center">
                      {r.qty || ''}
                    </td>
                    <td className="border-r border-black px-1 py-1.5 text-center">
                      {r.unit}
                    </td>
                    <td className="border-r border-black px-1 py-1.5 break-words">
                      {r.description}
                    </td>
                    <td className="border-r border-black px-1 py-1.5 text-right">
                      {r.bid1 ? formatNumber(r.bid1) : ''}
                    </td>
                    <td className="border-r border-black px-1 py-1.5 text-right">
                      {r.bid2 ? formatNumber(r.bid2) : ''}
                    </td>
                    <td className="px-1 py-1.5 text-right">
                      {r.bid3 ? formatNumber(r.bid3) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] pt-1">
              WINNING BIDDER: <strong>{p?.absWinner || ''}</strong>
            </p>
          </div>
        );
      }

      if (docType === 'po') {
        const items = Array.isArray(p?.poItems) ? p.poItems : [];
        const total = items.reduce((s, r) => s + r.qty * r.unitCost, 0);
        return (
          <div className="text-xs text-slate-950">
            <h1 className="text-center text-sm font-bold uppercase mb-3">
              PURCHASE ORDER
            </h1>
            <div className="border border-black text-[10px]">
              <div className="grid grid-cols-12 border-b border-black">
                <div className="col-span-6 p-2 font-bold">
                  Barangay: <span>KAUSWAGAN</span>
                </div>
                <div className="col-span-6 p-2">
                  <p>
                    City/Municipality: <strong>CAGAYAN DE ORO</strong>
                  </p>
                  <p>
                    Province: <strong>MISAMIS ORIENTAL</strong>
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-12 border-b border-black">
                <div className="col-span-6 p-2 space-y-1">
                  <p>
                    Supplier: <strong>{p?.poSupplier || rec.title}</strong>
                  </p>
                  <p>Address: {p?.poAddress || ''}</p>
                  <p>TIN: {p?.poTin || ''}</p>
                </div>
                <div className="col-span-6 p-2 space-y-1">
                  <p>
                    PO No.: <strong>{p?.poNumber || rec.finalId}</strong>
                  </p>
                  <p>Date: {p?.poDate || rec.dateText || ''}</p>
                  <p>
                    Mode of Procurement:{' '}
                    <strong>{p?.poMode || 'Shopping'}</strong>
                  </p>
                </div>
              </div>
              <table className="w-full table-fixed border-collapse text-[10px]">
                <thead>
                  <tr className="border-b border-black text-center font-bold">
                    <th className="w-[15%] border-r border-black px-1 py-1">
                      UNIT
                    </th>
                    <th className="w-[37%] border-r border-black px-1 py-1">
                      PARTICULARS
                    </th>
                    <th className="w-[16%] border-r border-black px-1 py-1">
                      QUANTITY
                    </th>
                    <th className="w-[16%] border-r border-black px-1 py-1">
                      UNIT COST
                    </th>
                    <th className="w-[16%] px-1 py-1">AMOUNT</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={row.id} className="border-b border-black">
                      <td className="border-r border-black px-1 py-1.5 text-center">
                        {row.unit}
                      </td>
                      <td className="border-r border-black px-1 py-1.5 text-center break-words">
                        {row.description}
                      </td>
                      <td className="border-r border-black px-1 py-1.5 text-center">
                        {row.qty || ''}
                      </td>
                      <td className="border-r border-black px-1 py-1.5 text-right">
                        {row.unitCost ? formatNumber(row.unitCost) : ''}
                      </td>
                      <td className="px-1 py-1.5 text-right">
                        {row.qty * row.unitCost
                          ? formatNumber(row.qty * row.unitCost)
                          : ''}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td colSpan={3} />
                    <td className="border-l border-black px-1 py-1 text-right">
                      TOTAL
                    </td>
                    <td className="px-1 py-1 text-center">
                      Php {total ? formatNumber(total) : ''}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      }

      const items = Array.isArray(p?.iarItems) ? p.iarItems : [];
      return (
        <div className="text-xs text-slate-950">
          <h1 className="text-center text-sm font-bold uppercase mb-3">
            INSPECTION AND ACCEPTANCE REPORT
          </h1>
          <div className="border border-black text-[10px]">
            <div className="border-b border-black p-2 space-y-0.5">
              <p>
                Barangay: <strong>Kauswagan</strong>
              </p>
              <p>
                City/Municipality: <strong>Cagayan de Oro City</strong>
              </p>
              <p>
                Province: <strong>Misamis Oriental</strong>
              </p>
            </div>
            <div className="grid grid-cols-12 border-b border-black p-2 gap-2">
              <div className="col-span-6 space-y-1">
                <p>Supplier: {p?.iarSupplier || rec.title}</p>
                <p>Address: {p?.iarAddress || ''}</p>
                <p>
                  P.O No: <strong>{p?.iarPoNo || ''}</strong>
                </p>
              </div>
              <div className="col-span-6 space-y-1">
                <p>Invoice No.: {p?.iarInvoiceNo || ''}</p>
                <p>AIR No.: {p?.iarAirNo || ''}</p>
                <p>CNTRL/RIS No.: {p?.iarRisNo || ''}</p>
              </div>
            </div>
            <table className="w-full table-fixed border-collapse text-[10px]">
              <thead>
                <tr className="border-b border-black text-center font-bold">
                  <th className="w-[24%] border-r border-black px-1 py-1">
                    UNIT
                  </th>
                  <th className="w-[46%] border-r border-black px-1 py-1">
                    DESCRIPTION
                  </th>
                  <th className="w-[30%] px-1 py-1">QUANTITY</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-b border-black">
                    <td className="border-r border-black px-1 py-2 text-center">
                      {row.unit}
                    </td>
                    <td className="border-r border-black px-1 py-2 break-words">
                      {row.description}
                    </td>
                    <td className="px-1 py-2 text-center">{row.qty || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    };

    return (
      <div {...panHandlers} className={`overflow-x-auto rounded-lg bg-slate-200/80 p-4 ${isDraggingPreview ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
        <div
          style={{
            width: `${widthMm}mm`,
            minHeight: `${minHeightMm}mm`,
            padding: '12mm',
          }}
          className="mx-auto overflow-hidden bg-white text-slate-900 shadow-lg ring-1 ring-slate-900/10"
        >
          {renderPreviewInner()}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <style>{`@media print { @page { size: ${paperSpec.cssSize} ${orientation}; margin: 20mm; } }`}</style>

      {floatingInput.visible && (
        <input
          ref={floatingRef}
          type={floatingInput.type}
          value={floatingInput.value}
          style={{
            top: `${floatingInput.top}px`,
            left: `${floatingInput.left}px`,
            width: `${floatingInput.width}px`,
            height: `${floatingInput.height}px`,
          }}
          onChange={(e) => {
            const raw = e.target.value;
            const next =
              floatingInput.type === 'number'
                ? raw.replace(/^0+(?=\d)/, '')
                : raw;
            setFloatingInput((prev) => ({ ...prev, value: next }));
            floatingInput.onCommit(next);
          }}
          onBlur={closeFloatingInput}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              closeFloatingInput();
            }
          }}
          className={`fixed z-50 rounded-md border-2 border-sky-600 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 shadow-xl ring-4 ring-sky-500/20 focus:outline-none ${
            floatingInput.align === 'right' ? 'text-right' : 'text-left'
          }`}
        />
      )}

      <SaveConfirmModal
        open={confirmSaveOpen}
        docLabel={currentTabMeta.label}
        recordTitle={getCurrentRecordTitle()}
        finalIdPreview={getDefaultFinalIdForCurrentTab()}
        isSaving={isSaving}
        onCancel={() => setConfirmSaveOpen(false)}
        onConfirm={() => void handleConfirmSave()}
      />

      <StatusDialog dialog={statusDialog} onClose={closeStatusDialog} />

      {isDatabaseDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-4"
        >
          <div className="w-full max-w-4xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-sky-700" />
                <h3 className="text-sm font-semibold text-slate-900">
                  {currentTabMeta.label} Database ({filteredDbRecords.length})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsDatabaseDialogOpen(false)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
              >
                <X className="h-4 w-4" />
                <span>Close</span>
              </button>
            </div>

            <div className="overflow-y-auto rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-xs">
                <thead className="bg-slate-50 text-slate-700 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">
                      Record ID
                    </th>
                    <th className="px-3 py-2 text-left font-semibold">Title</th>
                    <th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredDbRecords.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-3 py-6 text-center text-slate-500"
                      >
                        No saved {currentTabMeta.label} records yet.
                      </td>
                    </tr>
                  ) : (
                    filteredDbRecords.map((rec) => (
                      <tr key={rec.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-[11px] font-semibold text-sky-900">
                          {rec.finalId || 'Record'}
                        </td>
                        <td className="px-3 py-2 font-medium text-slate-900">
                          {rec.title}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {rec.dateText || '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setViewingRecord(rec)}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                            >
                              <Eye className="h-3 w-3" /> View
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditDialog(rec)}
                              className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1 text-[11px] font-medium text-sky-800 hover:bg-sky-100 cursor-pointer"
                            >
                              <Pencil className="h-3 w-3" /> Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingRecord(rec)}
                              className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100 cursor-pointer"
                            >
                              <Trash2 className="h-3 w-3" /> Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {viewingRecord && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div className="w-full max-w-4xl rounded-xl border border-slate-200 bg-slate-100 p-5 shadow-2xl space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white -m-5 mb-0 px-5 py-3 rounded-t-xl">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-sky-700" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Document Preview — {viewingRecord.docType.toUpperCase()} (
                  {viewingRecord.finalId || 'Record'})
                </h3>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePrint}
                  className="inline-flex items-center gap-1 rounded-md bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-800 cursor-pointer"
                >
                  <Printer className="h-3.5 w-3.5" />
                  <span>Print</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewingRecord(null)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                  <span>Close</span>
                </button>
              </div>
            </div>

            <div {...panHandlers} className={`overflow-y-auto pt-2 ${isDraggingPreview ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
              {renderRecordDocumentPreview(viewingRecord)}
            </div>
          </div>
        </div>
      )}

      {editingRecord && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <div className="flex items-center gap-2">
                <Pencil className="h-4 w-4 text-sky-700" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Edit Record ({editingRecord.finalId || 'Record'})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingRecord(null)}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700">
                  Title
                </label>
                <input
                  type="text"
                  value={editTitleDraft}
                  onChange={(e) => setEditTitleDraft(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700">
                  Date (YYYY-MM-DD)
                </label>
                <input
                  type="text"
                  value={editDateDraft}
                  onChange={(e) =>
                    setEditDateDraft(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setEditingRecord(null)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmEditLoad}
                className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 cursor-pointer"
              >
                Load into Editor
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingRecord && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <div className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-rose-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Delete Record
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDeletingRecord(null)}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-slate-700 leading-relaxed">
              Are you sure you want to delete{' '}
              <strong className="text-slate-900">
                {deletingRecord.finalId || 'Record'} — {deletingRecord.title}
              </strong>
              ?
            </p>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => setDeletingRecord(null)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => void handleConfirmDeleteRecord()}
                className="rounded-md bg-rose-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-800 disabled:opacity-50 cursor-pointer"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <PageTabs
        tabs={TABS.map(({ key, label }) => ({ key, label }))}
        activeTab={activeTab}
        onChange={(nextTab) => {
          setActiveTab(nextTab);
          if (nextTab === 'abstract') {
            setOrientation('landscape');
          } else {
            setOrientation('portrait');
          }
        }}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 items-start">
        <div className="no-print xl:col-span-4 rounded-xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
          <div className="border-b border-slate-200 pb-3">
            <h2 className="text-sm font-semibold text-slate-900">
              {currentTabMeta.label}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {currentTabMeta.description}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2">
            <span className="text-[11px] text-slate-600">
              Press{' '}
              <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-800">
                Enter
              </kbd>{' '}
              to save
            </span>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setRecordUuid(crypto.randomUUID());
                  setLoadedUpdatedAt(null);
                  setViewingRecord(false);
                  setEditing(false);
                  setIsDatabaseDialogOpen(false);
                }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                title="Start a new record using the current form values as a starting copy"
              >
                New
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={requestSaveConfirmation}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50 transition cursor-pointer"
              >
                <Save className="h-3.5 w-3.5" />
                <span>{isSaving ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </div>

          <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form ID · Automatically Generated</span>
            <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{getDefaultFinalIdForCurrentTab()}</span>
          </div>
          {renderFormInputs()}
        </div>

        <div className="xl:col-span-8 min-w-0 space-y-4">
          <div className="no-print flex flex-wrap items-center justify-end gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-2xs">
            <select
              aria-label="Paper Size"
              value={paperSize}
              onChange={(e) => setPaperSize(e.target.value as PaperSizeKey)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              {Object.entries(PAPER_DIMENSIONS).map(([key, spec]) => (
                <option key={key} value={key}>
                  {spec.label}
                </option>
              ))}
            </select>

            <select
              aria-label="Paper Orientation"
              value={orientation}
              onChange={(e) =>
                setOrientation(e.target.value as PaperOrientation)
              }
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>

            <button
              type="button"
              onClick={() => void handleDownloadPdf()}
              disabled={isDownloadingPdf}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-60 transition cursor-pointer"
            >
              <Download
                className={`h-3.5 w-3.5 ${
                  isDownloadingPdf ? 'animate-spin' : ''
                }`}
              />
              <span>{isDownloadingPdf ? 'Downloading...' : 'Download'}</span>
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 transition cursor-pointer"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>Print</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (isOfflineNow()) {
                  showNoInternetDialog();
                  return;
                }
                void loadProcurementRecordsFromSupabase(false)
                  .then(() => {
                    setIsDatabaseDialogOpen(true);
                  })
                  .catch((err) => {
                    showStatus(
                      'error',
                      'Database Load Failed',
                      'Could not load records from Supabase.',
                      err instanceof Error ? err.message : 'Please try again.'
                    );
                  });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100 transition cursor-pointer"
            >
              <Database className="h-3.5 w-3.5 text-sky-700" />
              <span>Database ({filteredDbRecords.length})</span>
            </button>
            <div className="inline-flex items-center gap-1.5 print:hidden">
              <span className="px-1 text-xs font-medium text-slate-600">Zoom</span>
              <button
                type="button"
                onClick={zoomOut}
                disabled={previewZoom <= 50}
                className="inline-flex w-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="inline-flex w-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                aria-label="Reset zoom to 100 percent"
              >
                {previewZoom}%
              </button>
              <button
                type="button"
                onClick={zoomIn}
                disabled={previewZoom >= 200}
                className="inline-flex w-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
          </div>

          <div ref={previewPanViewportRef} {...panHandlers} className={`min-w-0 overflow-auto rounded-xl border border-slate-300/80 bg-slate-200/80 p-4 print:overflow-visible print:rounded-none print:border-none print:bg-transparent print:p-0 ${isDraggingPreview ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
            <div className={`preview-pan-stage flex flex-col gap-6 ${previewZoom > 100 ? 'w-max min-w-full items-start px-[50%] print:w-full print:min-w-0 print:px-0' : 'w-full min-w-0 items-center'}`}>
                {previewPages.length > 0 && (
                  <div className="mb-4 flex items-center justify-center gap-2 print:hidden">
                    <button
                      type="button"
                      onClick={() => setPreviewPageIndex((prev) => Math.max(0, prev - 1))}
                      disabled={activePageIndex === 0}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span className="min-w-[84px] text-center text-xs font-medium text-slate-600">
                      Page {activePageIndex + 1} of {previewPages.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPreviewPageIndex((prev) => Math.min(previewPages.length - 1, prev + 1))}
                      disabled={activePageIndex >= previewPages.length - 1}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                )}
              
              {previewPages.length > 0 ? previewPages.map((page, index) => (
                <div
                  key={`preview-page-${index}`}
                  className={`relative shrink-0 overflow-hidden bg-white shadow-lg ring-1 ring-slate-900/10 ${index === activePageIndex ? 'block' : 'hidden print:block'}`}
                  style={{
                    width: previewZoom === 100
                      ? `min(100%, ${pageWidthMm}mm)`
                      : `${pageWidthMm * previewZoom / 100}mm`,
                    aspectRatio: `${pageWidthMm} / ${pageMinHeightMm}`,
                  }}
                >
                  <img
                    src={page}
                    alt={`Document preview page ${index + 1}`}
                    className="block h-full w-full select-none object-fill" 
                    draggable={false}
                  />
                </div>
              )) : (
                <div
                  className="flex w-full max-w-full flex-col items-center justify-center gap-2 bg-white px-8 text-center text-xs text-slate-500 shadow-lg ring-1 ring-slate-900/10"
                  style={{ width: `min(100%, ${pageWidthMm}mm)`, aspectRatio: `${pageWidthMm} / ${pageMinHeightMm}` }}
                >
                  {previewError ? (
                    <>
                      <span className="font-semibold text-rose-600">Paper preview failed</span>
                      <span className="max-w-full break-words">{previewError}</span>
                    </>
                  ) : (
                    <span>Preparing paper preview…</span>
                  )}
                </div>
              )}
            </div>

            <div
              ref={sheetRef}
              style={{
                position: 'fixed',
                left: '-10000px',
                top: '0',
                zIndex: -1,
                width: `${pageWidthMm}mm`,
                minHeight: `${pageMinHeightMm}mm`,
                padding: '20mm',
                overflow: 'hidden',
              }}
              className="mx-auto bg-white text-slate-900 shadow-lg ring-1 ring-slate-900/10 print:hidden"
            >
              {renderPaperSheetContent()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
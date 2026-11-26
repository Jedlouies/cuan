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

type DisbursementTabKey = 'dv' | 'certification' | 'liquidation' | 'rer';
type PaperSizeKey = 'a4' | 'letter' | 'legal';
type PaperOrientation = 'portrait' | 'landscape';
type DisbursementSupabaseTable =
  | 'disbursement_voucher'
  | 'certification'
  | 'liquidation_reports'
  | 'reimbursement_expense_receipts';

interface ParticularLineItem {
  id: string;
  particulars: string;
  amount: number;
}

interface SkcCheckItem {
  id: string;
  accountNo: string;
  checkNo: string;
  date: string;
  payee: string;
  amount: number;
  purpose: string;
}

interface DisbursementPayload {
  activeTab: DisbursementTabKey;
  paperSize?: PaperSizeKey;
  orientation?: PaperOrientation;
  createdBy?: string;
  // Disbursement Voucher (DV)
  dvNumber: string;
  dvDate: string;
  dvPayeeName: string;
  dvPayeeAddress: string;
  dvPayeeTin: string;
  dvItems: ParticularLineItem[];
  dvBudgetOfficer: string;
  dvTreasurer: string;
  dvChairperson: string;
  dvReceivedBy: string;
  dvReceivedDate: string;
  dvCheckNo: string;
  dvCheckDate: string;
  dvBankName: string;
  dvBankBranch: string;
  dvOrNo: string;
  dvOrDate: string;
  // SK Certification (SKCC / Annex 8)
  skcNumber: string;
  skcDate: string;
  skcBankTitle: string;
  skcBankName: string;
  skcBankAddress: string;
  skcCheckItems: SkcCheckItem[];
  skcChairperson: string;
  skcDeliveredBy: string;
  skcDeliveredDate: string;
  skcReceivedBy: string;
  skcReceivedDate: string;
  // Liquidation Report (LR)
  lrNumber: string;
  lrDate: string;
  lrItems: ParticularLineItem[];
  lrCashAdvanceDvNo: string;
  lrCashAdvanceDvDate: string;
  lrCashAdvanceAmount: number;
  lrRefundOrNo: string;
  lrRefundOrDate: string;
  lrRefundAmount: number;
  lrAccountableOfficial: string;
  lrAccountableDate: string;
  lrChairperson: string;
  lrChairpersonDate: string;
  lrTreasurer: string;
  lrTreasurerDate: string;
  // Reimbursement Expense Receipt (RER)
  rerNumber: string;
  rerDate: string;
  rerPayeeName: string;
  rerOfficialDesignation: string;
  rerItems: ParticularLineItem[];
  rerCertifiedBy: string;
  rerCertifiedDate: string;
  rerApprovedBy: string;
  rerApprovedDate: string;
}

export interface DisbursementDbRecord {
  id: string;
  finalId: string;
  tableName: DisbursementSupabaseTable;
  docType: DisbursementTabKey;
  title: string;
  dateText: string;
  updatedAt: string;
  payload: DisbursementPayload;
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

const AUTOSAVE_STORAGE_KEY = 'sk_disbursements_autosave_v1';

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
  key: DisbursementTabKey;
  label: string;
  description: string;
  tableName: DisbursementSupabaseTable;
}[] = [
  {
    key: 'dv',
    label: 'Disbursement Voucher (DV)',
    description: 'Payment vouchers and obligation certifications',
    tableName: 'disbursement_voucher',
  },
  {
    key: 'certification',
    label: 'SK Certification',
    description: 'Official SK expenditure and fund availability certifications',
    tableName: 'certification',
  },
  {
    key: 'liquidation',
    label: 'Liquidation Report',
    description: 'Cash advance liquidations and supporting receipts',
    tableName: 'liquidation_reports',
  },
  {
    key: 'rer',
    label: 'Reimbursement Expense Receipt (RER)',
    description: 'Non-receipted minor expense certifications',
    tableName: 'reimbursement_expense_receipts',
  },
];

const FIXED_SK_CHAIRPERSON = 'HON. RANCE EMIL D. ACHACOSO';
const FIXED_SK_TREASURER = 'JAN MACKENXIE B. NAVARRO';
const FIXED_BUDGET_OFFICER = 'HON. ABIJAH MIGUEL C. PACANA';

const ACCOUNTABLE_OFFICIAL_OPTIONS: string[] = [
  'HON. RANCE EMIL D. ACHACOSO',
  'JAN MACKENXIE B. NAVARRO',
  'HON. ABIJAH MIGUEL C. PACANA',
  'HON. EFREN F. CORPUZ',
  'HON. MARY JULLIAN DEL PUERTO',
  'HON. ELRISH JOHN L. DAAYATA',
  'MR. ALVIN GABRIEL B. CAHOY',
  'HON. SHANNEN KATE M. RAMOS',
  'HON. RUCHELLE KYLE B. BAAL',
  'HON. DHAR KENZOE B. OBSIOMA',
];

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

export function DisbursementsPage() {
  const [activeTab, setActiveTab] = useState<DisbursementTabKey>('dv');
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('a4');
  const [orientation, setOrientation] = useState<PaperOrientation>('portrait');
  const [createdBy, setCreatedBy] = useState<string>(FIXED_SK_TREASURER);

  useEffect(() => {
    let active = true;

    const resolveLoggedInUser = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const user = session?.user;
        if (!active || !user) return;

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
      } catch {
        // Ignore auth lookup issues
      }
    };

    void resolveLoggedInUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const user = session?.user;
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

  const [, setIsConnectingSupabase] = useState<boolean>(false);
  const hasRestoredAutosaveRef = useRef<boolean>(false);

  const [isDatabaseDialogOpen, setIsDatabaseDialogOpen] =
    useState<boolean>(false);
  const [viewingRecord, setViewingRecord] =
    useState<DisbursementDbRecord | null>(null);
  const [editingRecord, setEditingRecord] =
    useState<DisbursementDbRecord | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState<string>('');
  const [editDateDraft, setEditDateDraft] = useState<string>('');
  const [deletingRecord, setDeletingRecord] =
    useState<DisbursementDbRecord | null>(null);
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
        'You are currently offline. Your changes are automatically saved locally in this browser.',
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
  const [, setFinalId] = useState<string>(() => generateUniqueDocNumber([]));
  const [dbRecords, setDbRecords] = useState<DisbursementDbRecord[]>([]);
  const [usedDocNumbers, setUsedDocNumbers] = useState<string[]>([]);

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

  // 1. Disbursement Voucher (DV)
  const [dvNumber, setDvNumber] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [dvDate, setDvDate] = useState('2026-11-24');
  const [dvPayeeName, setDvPayeeName] = useState("Selwyn's Catering Services");
  const [dvPayeeAddress, setDvPayeeAddress] = useState('D-4 Puntod, CDOC');
  const [dvPayeeTin, setDvPayeeTin] = useState('648-297-215-00000');
  const [dvItems, setDvItems] = useState<ParticularLineItem[]>([
    {
      id: 'dv-1',
      particulars: 'Payment for catering services',
      amount: 0,
    },
  ]);
  const dvBudgetOfficer = FIXED_BUDGET_OFFICER;
  const dvTreasurer = FIXED_SK_TREASURER;
  const dvChairperson = FIXED_SK_CHAIRPERSON;
  const [dvReceivedBy, setDvReceivedBy] = useState('');
  const [dvReceivedDate, setDvReceivedDate] = useState('');
  const [dvCheckNo, setDvCheckNo] = useState('');
  const [dvCheckDate, setDvCheckDate] = useState('');
  const [dvBankName, setDvBankName] = useState('');
  const [dvBankBranch, setDvBankBranch] = useState('');
  const [dvOrNo, setDvOrNo] = useState('');
  const [dvOrDate, setDvOrDate] = useState('');

  // 2. SK Certification (certification / Annex 8)
  const [skcNumber, setSkcNumber] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [skcDate, setSkcDate] = useState('2026-11-24');
  const [skcBankTitle, setSkcBankTitle] = useState('The Bank Manager');
  const [skcBankName, setSkcBankName] = useState('');
  const [skcBankAddress, setSkcBankAddress] = useState('');
  const [skcCheckItems, setSkcCheckItems] = useState<SkcCheckItem[]>([
    {
      id: 'skc-1',
      accountNo: '',
      checkNo: '',
      date: '',
      payee: '',
      amount: 0,
      purpose: '',
    },
  ]);
  const skcChairperson = FIXED_SK_CHAIRPERSON;
  const skcDeliveredBy = FIXED_SK_TREASURER;
  const [skcDeliveredDate, setSkcDeliveredDate] = useState('');
  const [skcReceivedBy, setSkcReceivedBy] = useState('');
  const [skcReceivedDate, setSkcReceivedDate] = useState('');

  // 3. Liquidation Report (liquidation)
  const [lrNumber, setLrNumber] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [lrDate, setLrDate] = useState('2026-11-24');
  const [lrItems, setLrItems] = useState<ParticularLineItem[]>([
    {
      id: 'lr-1',
      particulars: '',
      amount: 0,
    },
  ]);
  const [lrCashAdvanceDvNo, setLrCashAdvanceDvNo] = useState('');
  const [lrCashAdvanceDvDate, setLrCashAdvanceDvDate] = useState('');
  const [lrCashAdvanceAmount, setLrCashAdvanceAmount] = useState<number>(0);
  const [lrRefundOrNo, setLrRefundOrNo] = useState('');
  const [lrRefundOrDate, setLrRefundOrDate] = useState('');
  const [lrRefundAmount, setLrRefundAmount] = useState<number>(0);
  const [lrAccountableOfficial, setLrAccountableOfficial] = useState(
    ACCOUNTABLE_OFFICIAL_OPTIONS[0]
  );
  const [lrAccountableDate, setLrAccountableDate] = useState('');
  const lrChairperson = FIXED_SK_CHAIRPERSON;
  const [lrChairpersonDate, setLrChairpersonDate] = useState('');
  const lrTreasurer = FIXED_SK_TREASURER;
  const [lrTreasurerDate, setLrTreasurerDate] = useState('');

  // 4. Reimbursement Expense Receipt (rer)
  const [rerNumber, setRerNumber] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [rerDate, setRerDate] = useState('2026-11-24');
  const [rerPayeeName, setRerPayeeName] = useState('');
  const [rerOfficialDesignation, setRerOfficialDesignation] =
    useState('SK Official');
  const [rerItems, setRerItems] = useState<ParticularLineItem[]>([
    {
      id: 'rer-1',
      particulars: '',
      amount: 0,
    },
  ]);
  const rerCertifiedBy = FIXED_SK_TREASURER;
  const [rerCertifiedDate, setRerCertifiedDate] = useState('');
  const rerApprovedBy = FIXED_SK_CHAIRPERSON;
  const [rerApprovedDate, setRerApprovedDate] = useState('');

  const buildCurrentPayload = useCallback(
    (): DisbursementPayload => ({
      activeTab,
      paperSize,
      orientation,
      createdBy: (createdBy || FIXED_SK_TREASURER).trim(),
      dvNumber,
      dvDate,
      dvPayeeName,
      dvPayeeAddress,
      dvPayeeTin,
      dvItems,
      dvBudgetOfficer,
      dvTreasurer,
      dvChairperson,
      dvReceivedBy,
      dvReceivedDate,
      dvCheckNo,
      dvCheckDate,
      dvBankName,
      dvBankBranch,
      dvOrNo,
      dvOrDate,
      skcNumber,
      skcDate,
      skcBankTitle,
      skcBankName,
      skcBankAddress,
      skcCheckItems,
      skcChairperson,
      skcDeliveredBy,
      skcDeliveredDate,
      skcReceivedBy,
      skcReceivedDate,
      lrNumber,
      lrDate,
      lrItems,
      lrCashAdvanceDvNo,
      lrCashAdvanceDvDate,
      lrCashAdvanceAmount,
      lrRefundOrNo,
      lrRefundOrDate,
      lrRefundAmount,
      lrAccountableOfficial,
      lrAccountableDate,
      lrChairperson,
      lrChairpersonDate,
      lrTreasurer,
      lrTreasurerDate,
      rerNumber,
      rerDate,
      rerPayeeName,
      rerOfficialDesignation,
      rerItems,
      rerCertifiedBy,
      rerCertifiedDate,
      rerApprovedBy,
      rerApprovedDate,
    }),
    [
      activeTab,
      paperSize,
      orientation,
      createdBy,
      dvNumber,
      dvDate,
      dvPayeeName,
      dvPayeeAddress,
      dvPayeeTin,
      dvItems,
      dvBudgetOfficer,
      dvTreasurer,
      dvChairperson,
      dvReceivedBy,
      dvReceivedDate,
      dvCheckNo,
      dvCheckDate,
      dvBankName,
      dvBankBranch,
      dvOrNo,
      dvOrDate,
      skcNumber,
      skcDate,
      skcBankTitle,
      skcBankName,
      skcBankAddress,
      skcCheckItems,
      skcChairperson,
      skcDeliveredBy,
      skcDeliveredDate,
      skcReceivedBy,
      skcReceivedDate,
      lrNumber,
      lrDate,
      lrItems,
      lrCashAdvanceDvNo,
      lrCashAdvanceDvDate,
      lrCashAdvanceAmount,
      lrRefundOrNo,
      lrRefundOrDate,
      lrRefundAmount,
      lrAccountableOfficial,
      lrAccountableDate,
      lrChairperson,
      lrChairpersonDate,
      lrTreasurer,
      lrTreasurerDate,
      rerNumber,
      rerDate,
      rerPayeeName,
      rerOfficialDesignation,
      rerItems,
      rerCertifiedBy,
      rerCertifiedDate,
      rerApprovedBy,
      rerApprovedDate,
    ]
  );

  const writeAutosaveNow = useCallback(
    (overrideUuid?: string, overridePayload?: DisbursementPayload) => {
      try {
        const snapshot = {
          id: overrideUuid ?? recordUuid,
          savedAt: new Date().toISOString(),
          payload: overridePayload ?? buildCurrentPayload(),
        };
        window.localStorage.setItem(
          AUTOSAVE_STORAGE_KEY,
          JSON.stringify(snapshot)
        );
      } catch {
        // Ignore storage quota or restricted storage errors
      }
    },
    [buildCurrentPayload, recordUuid]
  );

  const applyPayloadToEditor = useCallback(
    (p: Partial<DisbursementPayload>, overrideUuid?: string) => {
      if (overrideUuid) setRecordUuid(overrideUuid);
      if (p.activeTab) setActiveTab(p.activeTab);
      if (p.paperSize) setPaperSize(p.paperSize);
      if (p.orientation) setOrientation(p.orientation);
      if (p.createdBy !== undefined) setCreatedBy(p.createdBy);
      if (p.dvNumber !== undefined) {
        setDvNumber(p.dvNumber.trim() || generateUniqueDocNumber([]));
      }
      if (p.dvDate !== undefined) setDvDate(p.dvDate);
      if (p.dvPayeeName !== undefined) setDvPayeeName(p.dvPayeeName);
      if (p.dvPayeeAddress !== undefined) setDvPayeeAddress(p.dvPayeeAddress);
      if (p.dvPayeeTin !== undefined) setDvPayeeTin(p.dvPayeeTin);
      if (Array.isArray(p.dvItems)) setDvItems(p.dvItems);
      if (p.dvReceivedBy !== undefined) setDvReceivedBy(p.dvReceivedBy);
      if (p.dvReceivedDate !== undefined) setDvReceivedDate(p.dvReceivedDate);
      if (p.dvCheckNo !== undefined) setDvCheckNo(p.dvCheckNo);
      if (p.dvCheckDate !== undefined) setDvCheckDate(p.dvCheckDate);
      if (p.dvBankName !== undefined) setDvBankName(p.dvBankName);
      if (p.dvBankBranch !== undefined) setDvBankBranch(p.dvBankBranch);
      if (p.dvOrNo !== undefined) setDvOrNo(p.dvOrNo);
      if (p.dvOrDate !== undefined) setDvOrDate(p.dvOrDate);
      if (p.skcNumber !== undefined) {
        setSkcNumber(p.skcNumber.trim() || generateUniqueDocNumber([]));
      }
      if (p.skcDate !== undefined) setSkcDate(p.skcDate);
      if (p.skcBankTitle !== undefined) setSkcBankTitle(p.skcBankTitle);
      if (p.skcBankName !== undefined) setSkcBankName(p.skcBankName);
      if (p.skcBankAddress !== undefined) setSkcBankAddress(p.skcBankAddress);
      if (Array.isArray(p.skcCheckItems)) setSkcCheckItems(p.skcCheckItems);
      if (p.skcDeliveredDate !== undefined)
        setSkcDeliveredDate(p.skcDeliveredDate);
      if (p.skcReceivedBy !== undefined) setSkcReceivedBy(p.skcReceivedBy);
      if (p.skcReceivedDate !== undefined)
        setSkcReceivedDate(p.skcReceivedDate);
      if (p.lrNumber !== undefined) {
        setLrNumber(p.lrNumber.trim() || generateUniqueDocNumber([]));
      }
      if (p.lrDate !== undefined) setLrDate(p.lrDate);
      if (Array.isArray(p.lrItems)) setLrItems(p.lrItems);
      if (p.lrCashAdvanceDvNo !== undefined)
        setLrCashAdvanceDvNo(p.lrCashAdvanceDvNo);
      if (p.lrCashAdvanceDvDate !== undefined)
        setLrCashAdvanceDvDate(p.lrCashAdvanceDvDate);
      if (p.lrCashAdvanceAmount !== undefined)
        setLrCashAdvanceAmount(p.lrCashAdvanceAmount);
      if (p.lrRefundOrNo !== undefined) setLrRefundOrNo(p.lrRefundOrNo);
      if (p.lrRefundOrDate !== undefined) setLrRefundOrDate(p.lrRefundOrDate);
      if (p.lrRefundAmount !== undefined) setLrRefundAmount(p.lrRefundAmount);
      if (p.lrAccountableOfficial !== undefined)
        setLrAccountableOfficial(
          p.lrAccountableOfficial || ACCOUNTABLE_OFFICIAL_OPTIONS[0]
        );
      if (p.lrAccountableDate !== undefined)
        setLrAccountableDate(p.lrAccountableDate);
      if (p.lrChairpersonDate !== undefined)
        setLrChairpersonDate(p.lrChairpersonDate);
      if (p.lrTreasurerDate !== undefined)
        setLrTreasurerDate(p.lrTreasurerDate);
      if (p.rerNumber !== undefined) {
        setRerNumber(p.rerNumber.trim() || generateUniqueDocNumber([]));
      }
      if (p.rerDate !== undefined) setRerDate(p.rerDate);
      if (p.rerPayeeName !== undefined) setRerPayeeName(p.rerPayeeName);
      if (p.rerOfficialDesignation !== undefined)
        setRerOfficialDesignation(p.rerOfficialDesignation);
      if (Array.isArray(p.rerItems)) setRerItems(p.rerItems);
      if (p.rerCertifiedDate !== undefined)
        setRerCertifiedDate(p.rerCertifiedDate);
      if (p.rerApprovedDate !== undefined)
        setRerApprovedDate(p.rerApprovedDate);
    },
    []
  );

  useEffect(() => {
    if (hasRestoredAutosaveRef.current) return;
    hasRestoredAutosaveRef.current = true;
    try {
      const raw = window.localStorage.getItem(AUTOSAVE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        id?: string;
        payload?: Partial<DisbursementPayload>;
      };
      if (parsed?.payload) {
        applyPayloadToEditor(parsed.payload, parsed.id);
      }
    } catch {
      // Ignore storage read errors
    }
  }, [applyPayloadToEditor]);

  useEffect(() => {
    if (!hasRestoredAutosaveRef.current) return;
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
  }, [writeAutosaveNow]);

  const getCurrentRecordTitle = useCallback((): string => {
    if (activeTab === 'dv') return dvPayeeName || `DV ${dvNumber}`;
    if (activeTab === 'certification') return skcBankName || `SKCC ${skcNumber}`;
    if (activeTab === 'liquidation')
      return lrAccountableOfficial || `LR ${lrNumber}`;
    return rerPayeeName || `RER ${rerNumber}`;
  }, [
    activeTab,
    dvPayeeName,
    dvNumber,
    skcBankName,
    skcNumber,
    lrAccountableOfficial,
    lrNumber,
    rerPayeeName,
    rerNumber,
  ]);

  const hydrateNumbersFromDbRows = useCallback((rows: DisbursementDbRecord[]) => {
    const allNos = rows
      .map((r) => r.finalId)
      .filter((v): v is string => Boolean(v));
    setUsedDocNumbers((prev) => Array.from(new Set([...prev, ...allNos])));

    const dvNos = rows
      .filter((r) => r.docType === 'dv')
      .map((r) => r.finalId || r.payload?.dvNumber)
      .filter((v): v is string => Boolean(v));
    const skcNos = rows
      .filter((r) => r.docType === 'certification')
      .map((r) => r.finalId || r.payload?.skcNumber)
      .filter((v): v is string => Boolean(v));
    const lrNos = rows
      .filter((r) => r.docType === 'liquidation')
      .map((r) => r.finalId || r.payload?.lrNumber)
      .filter((v): v is string => Boolean(v));
    const rerNos = rows
      .filter((r) => r.docType === 'rer')
      .map((r) => r.finalId || r.payload?.rerNumber)
      .filter((v): v is string => Boolean(v));

    setDvNumber((curr) =>
      dvNos.includes(curr) ? generateUniqueDocNumber(dvNos) : curr
    );
    setSkcNumber((curr) =>
      skcNos.includes(curr) ? generateUniqueDocNumber(skcNos) : curr
    );
    setLrNumber((curr) =>
      lrNos.includes(curr) ? generateUniqueDocNumber(lrNos) : curr
    );
    setRerNumber((curr) =>
      rerNos.includes(curr) ? generateUniqueDocNumber(rerNos) : curr
    );
  }, []);

  const loadDisbursementRecordsFromSupabase = useCallback(
    async (silentIfOffline = false): Promise<DisbursementDbRecord[]> => {
      if (isOfflineNow()) {
        if (!silentIfOffline) {
          showNoInternetDialog();
        }
        return [];
      }

      const collected: DisbursementDbRecord[] = [];

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
              ? (row.payload as Partial<DisbursementPayload>)
              : {};

          const dvNo = String(row.dv_number ?? savedPayload.dvNumber ?? '');
          const skcNo = String(row.skc_number ?? savedPayload.skcNumber ?? '');
          const lrNo = String(row.lr_number ?? savedPayload.lrNumber ?? '');
          const rerNo = String(row.rer_number ?? savedPayload.rerNumber ?? '');

          const finalDocId =
            tab.key === 'dv'
              ? dvNo || id.slice(0, 8).toUpperCase()
              : tab.key === 'certification'
              ? skcNo || id.slice(0, 8).toUpperCase()
              : tab.key === 'liquidation'
              ? lrNo || id.slice(0, 8).toUpperCase()
              : rerNo || id.slice(0, 8).toUpperCase();

          const recTitle = String(
            row.payee_name ??
              row.bank_name ??
              row.accountable_official_name ??
              savedPayload.dvPayeeName ??
              savedPayload.skcBankName ??
              savedPayload.lrAccountableOfficial ??
              savedPayload.rerPayeeName ??
              `Untitled ${tab.label}`
          );

          const recDate = String(
            row.dv_date ??
              row.skc_date ??
              row.lr_date ??
              row.rer_date ??
              savedPayload.dvDate ??
              savedPayload.skcDate ??
              savedPayload.lrDate ??
              savedPayload.rerDate ??
              ''
          );

          const payload: DisbursementPayload = {
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
            dvNumber: dvNo || generateUniqueDocNumber([]),
            dvDate: String(row.dv_date ?? savedPayload.dvDate ?? '2026-11-24'),
            dvPayeeName: String(
              row.payee_name ?? savedPayload.dvPayeeName ?? ''
            ),
            dvPayeeAddress: String(
              row.payee_address ?? savedPayload.dvPayeeAddress ?? ''
            ),
            dvPayeeTin: String(row.payee_tin ?? savedPayload.dvPayeeTin ?? ''),
            dvItems:
              Array.isArray(row.items) && tab.key === 'dv'
                ? (row.items as ParticularLineItem[])
                : savedPayload.dvItems ?? [],
            dvBudgetOfficer: FIXED_BUDGET_OFFICER,
            dvTreasurer: FIXED_SK_TREASURER,
            dvChairperson: FIXED_SK_CHAIRPERSON,
            dvReceivedBy: String(
              row.received_by_name ?? savedPayload.dvReceivedBy ?? ''
            ),
            dvReceivedDate: String(
              row.received_date ?? savedPayload.dvReceivedDate ?? ''
            ),
            dvCheckNo: String(
              row.check_number ?? savedPayload.dvCheckNo ?? ''
            ),
            dvCheckDate: String(
              row.check_date ?? savedPayload.dvCheckDate ?? ''
            ),
            dvBankName: String(row.bank_name ?? savedPayload.dvBankName ?? ''),
            dvBankBranch: String(
              row.bank_branch ?? savedPayload.dvBankBranch ?? ''
            ),
            dvOrNo: String(row.or_number ?? savedPayload.dvOrNo ?? ''),
            dvOrDate: String(row.or_date ?? savedPayload.dvOrDate ?? ''),
            skcNumber: skcNo || generateUniqueDocNumber([]),
            skcDate: String(
              row.skc_date ?? savedPayload.skcDate ?? '2026-11-24'
            ),
            skcBankTitle: String(
              row.bank_recipient_title ??
                savedPayload.skcBankTitle ??
                'The Bank Manager'
            ),
            skcBankName: String(
              row.bank_name ?? savedPayload.skcBankName ?? ''
            ),
            skcBankAddress: String(
              row.bank_address ?? savedPayload.skcBankAddress ?? ''
            ),
            skcCheckItems:
              Array.isArray(row.check_items) && tab.key === 'certification'
                ? (row.check_items as SkcCheckItem[])
                : savedPayload.skcCheckItems ?? [],
            skcChairperson: FIXED_SK_CHAIRPERSON,
            skcDeliveredBy: FIXED_SK_TREASURER,
            skcDeliveredDate: String(
              row.signed_by_date ?? savedPayload.skcDeliveredDate ?? ''
            ),
            skcReceivedBy: String(
              row.received_by_name ?? savedPayload.skcReceivedBy ?? ''
            ),
            skcReceivedDate: String(
              row.received_date ?? savedPayload.skcReceivedDate ?? ''
            ),
            lrNumber: lrNo || generateUniqueDocNumber([]),
            lrDate: String(row.lr_date ?? savedPayload.lrDate ?? '2026-11-24'),
            lrItems:
              Array.isArray(row.items) && tab.key === 'liquidation'
                ? (row.items as ParticularLineItem[])
                : savedPayload.lrItems ?? [],
            lrCashAdvanceDvNo: String(
              row.cash_advance_dv_number ?? savedPayload.lrCashAdvanceDvNo ?? ''
            ),
            lrCashAdvanceDvDate: String(
              row.cash_advance_dv_date ?? savedPayload.lrCashAdvanceDvDate ?? ''
            ),
            lrCashAdvanceAmount: Number(
              row.amount_of_cash_advance ??
                savedPayload.lrCashAdvanceAmount ??
                0
            ),
            lrRefundOrNo: String(
              row.refund_or_number ?? savedPayload.lrRefundOrNo ?? ''
            ),
            lrRefundOrDate: String(
              row.refund_or_date ?? savedPayload.lrRefundOrDate ?? ''
            ),
            lrRefundAmount: Number(
              row.amount_refunded ?? savedPayload.lrRefundAmount ?? 0
            ),
            lrAccountableOfficial: String(
              row.accountable_official_name ??
                savedPayload.lrAccountableOfficial ??
                ACCOUNTABLE_OFFICIAL_OPTIONS[0]
            ),
            lrAccountableDate: String(
              row.accountable_official_date ??
                savedPayload.lrAccountableDate ??
                ''
            ),
            lrChairperson: FIXED_SK_CHAIRPERSON,
            lrChairpersonDate: String(
              row.sk_chairperson_date ?? savedPayload.lrChairpersonDate ?? ''
            ),
            lrTreasurer: FIXED_SK_TREASURER,
            lrTreasurerDate: String(
              row.sk_treasurer_date ?? savedPayload.lrTreasurerDate ?? ''
            ),
            rerNumber: rerNo || generateUniqueDocNumber([]),
            rerDate: String(
              row.rer_date ?? savedPayload.rerDate ?? '2026-11-24'
            ),
            rerPayeeName: String(
              row.payee_name ?? savedPayload.rerPayeeName ?? ''
            ),
            rerOfficialDesignation: String(
              row.official_designation ??
                savedPayload.rerOfficialDesignation ??
                'SK Official'
            ),
            rerItems:
              Array.isArray(row.items) && tab.key === 'rer'
                ? (row.items as ParticularLineItem[])
                : savedPayload.rerItems ?? [],
            rerCertifiedBy: FIXED_SK_TREASURER,
            rerCertifiedDate: String(
              row.certified_by_date ?? savedPayload.rerCertifiedDate ?? ''
            ),
            rerApprovedBy: FIXED_SK_CHAIRPERSON,
            rerApprovedDate: String(
              row.approved_by_date ?? savedPayload.rerApprovedDate ?? ''
            ),
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
      hydrateNumbersFromDbRows(collected);
      return collected;
    },
    [hydrateNumbersFromDbRows, showNoInternetDialog]
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
      void loadDisbursementRecordsFromSupabase(true).catch(() => {});
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
        await loadDisbursementRecordsFromSupabase(true);
      } catch {
        // Ignore offline errors
      }
    };

    void initLoad();

    return () => {
      active = false;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [loadDisbursementRecordsFromSupabase, showNoInternetDialog, writeAutosaveNow]);

  const currentTabMeta = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  const filteredDbRecords = dbRecords.filter(
    (rec) =>
      rec.docType === activeTab || rec.tableName === currentTabMeta.tableName
  );

  const dvTotal = dvItems.reduce((sum, r) => sum + r.amount, 0);
  const skcTotal = skcCheckItems.reduce((sum, r) => sum + r.amount, 0);
  const lrTotalSpent = lrItems.reduce((sum, r) => sum + r.amount, 0);
  const lrAmountToBeReimbursed = Math.max(
    0,
    lrTotalSpent - lrCashAdvanceAmount - lrRefundAmount
  );
  const rerTotal = rerItems.reduce((sum, r) => sum + r.amount, 0);

  const getDefaultFinalIdForCurrentTab = (): string => {
    if (activeTab === 'dv') return dvNumber;
    if (activeTab === 'certification') return skcNumber;
    if (activeTab === 'liquidation') return lrNumber;
    return rerNumber;
  };

  const handleGenerateNewNumberForCurrentTab = () => {
    const dbNosForTab = dbRecords
      .filter((r) => r.docType === activeTab)
      .map((r) => r.finalId);

    if (activeTab === 'dv') {
      const next = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbNosForTab,
        dvNumber,
      ]);
      setUsedDocNumbers((prev) => Array.from(new Set([...prev, dvNumber, next])));
      setRecordUuid(crypto.randomUUID());
      setFinalId(next);
      setDvNumber(next);
    } else if (activeTab === 'certification') {
      const next = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbNosForTab,
        skcNumber,
      ]);
      setUsedDocNumbers((prev) =>
        Array.from(new Set([...prev, skcNumber, next]))
      );
      setRecordUuid(crypto.randomUUID());
      setFinalId(next);
      setSkcNumber(next);
    } else if (activeTab === 'liquidation') {
      const next = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbNosForTab,
        lrNumber,
      ]);
      setUsedDocNumbers((prev) => Array.from(new Set([...prev, lrNumber, next])));
      setRecordUuid(crypto.randomUUID());
      setFinalId(next);
      setLrNumber(next);
    } else {
      const next = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbNosForTab,
        rerNumber,
      ]);
      setUsedDocNumbers((prev) =>
        Array.from(new Set([...prev, rerNumber, next]))
      );
      setRecordUuid(crypto.randomUUID());
      setFinalId(next);
      setRerNumber(next);
    }
  };

  const paperSpec = PAPER_DIMENSIONS[paperSize];
  const pageWidthMm =
    orientation === 'portrait' ? paperSpec.widthMm : paperSpec.heightMm;
  const pageMinHeightMm =
    orientation === 'portrait' ? paperSpec.heightMm : paperSpec.widthMm;


  // Render the full document off-screen, then show it as fixed-size paper pages.
  // This prevents long records from stretching one preview sheet vertically.
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

          // html2canvas cannot reliably capture an element positioned far outside
          // the viewport. Clone the paper into a temporary in-viewport host.
          const captureHost = document.createElement('div');
          const captureId = `sk-paper-capture-${activeTab}-${thisRender}`;
          captureHost.id = captureId;
          captureHost.style.position = 'fixed';
          captureHost.style.left = '0';
          captureHost.style.top = '0';
          captureHost.style.zIndex = '2147483000';
          captureHost.style.opacity = '0';
          captureHost.style.pointerEvents = 'none';
          captureHost.style.background = '#ffffff';

          const captureClone = source.cloneNode(true) as HTMLElement;
          captureClone.style.position = 'static';
          captureClone.style.left = 'auto';
          captureClone.style.top = 'auto';
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
          captureClone.querySelectorAll<HTMLElement>('p, span, div, li, td, th').forEach((element) => {
            element.style.maxWidth = '100%';
            element.style.overflowWrap = 'anywhere';
            element.style.wordBreak = 'break-word';
          });
          captureHost.appendChild(captureClone);
          document.body.appendChild(captureHost);

          let canvas: HTMLCanvasElement;
          try {
            canvas = await html2canvas(captureClone, {
              scale: 1.5,
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
              canvas, 0, y, canvas.width, sliceHeight,
              0, 0, canvas.width, sliceHeight
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
              error instanceof Error ? error.message : 'Could not render the page preview.'
            );
          }
        }
      }, 180);
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
  }, [pageWidthMm, pageMinHeightMm, activeTab]);

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
      clone.classList.remove('shadow-lg', 'ring-1', 'mx-auto');

      const holder = document.createElement('div');
      holder.style.position = 'fixed';
      holder.style.left = '-10000px';
      holder.style.top = '0';
      holder.appendChild(clone);
      document.body.appendChild(holder);

      let canvas: HTMLCanvasElement;
      try {
        canvas = await html2canvas(clone, {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          height: clone.scrollHeight,
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

  const buildSupabaseRowForTab = (): Record<string, unknown> => {
    const actor = (createdBy || FIXED_SK_TREASURER).trim();

    if (activeTab === 'dv') {
      const effectiveDvNo =
        (dvNumber ?? '').trim() ||
        generateUniqueDocNumber([...usedDocNumbers]);
      const joinedParticulars =
        dvItems
          .map((it) => it.particulars.trim())
          .filter(Boolean)
          .join('; ') || 'Disbursement Voucher';
      return {
        id: recordUuid,
        dv_number: effectiveDvNo,
        barangay: 'Kauswagan',
        city: 'Cagayan de Oro City',
        province: 'Misamis Oriental',
        dv_date: dvDate || new Date().toISOString().slice(0, 10),
        payee_name: dvPayeeName || 'Payee',
        payee_address: dvPayeeAddress || null,
        payee_tin: dvPayeeTin || null,
        particulars: joinedParticulars,
        items: dvItems,
        total_amount: dvTotal,
        budget_officer_name: FIXED_BUDGET_OFFICER,
        sk_treasurer_name: FIXED_SK_TREASURER,
        sk_chairperson_name: FIXED_SK_CHAIRPERSON,
        received_by_name: dvReceivedBy || null,
        received_date: dvReceivedDate || null,
        check_number: dvCheckNo || null,
        check_date: dvCheckDate || null,
        bank_name: dvBankName || null,
        bank_branch: dvBankBranch || null,
        or_number: dvOrNo || null,
        or_date: dvOrDate || null,
        created_by: actor,
      };
    }

    if (activeTab === 'certification') {
      const effectiveSkcNo =
        (skcNumber ?? '').trim() ||
        generateUniqueDocNumber([...usedDocNumbers]);
      return {
        id: recordUuid,
        skc_number: effectiveSkcNo,
        skc_date: skcDate || new Date().toISOString().slice(0, 10),
        barangay: 'Kauswagan',
        city: 'Cagayan de Oro City',
        province: 'Misamis Oriental',
        region: 'Region X',
        bank_recipient_title: skcBankTitle || 'The Bank Manager',
        bank_name: skcBankName || 'Bank',
        bank_address: skcBankAddress || null,
        check_items: skcCheckItems,
        total_amount: skcTotal,
        sk_chairperson_name: FIXED_SK_CHAIRPERSON,
        signed_by_name: FIXED_SK_TREASURER,
        signed_by_date: skcDeliveredDate || null,
        received_by_name: skcReceivedBy || null,
        received_date: skcReceivedDate || null,
        created_by: actor,
      };
    }

    if (activeTab === 'liquidation') {
      const effectiveLrNo =
        (lrNumber ?? '').trim() ||
        generateUniqueDocNumber([...usedDocNumbers]);
      return {
        id: recordUuid,
        lr_number: effectiveLrNo,
        barangay: 'Kauswagan',
        city: 'Cagayan de Oro City',
        province: 'Misamis Oriental',
        lr_date: lrDate || new Date().toISOString().slice(0, 10),
        items: lrItems,
        cash_advance_dv_number: lrCashAdvanceDvNo || null,
        cash_advance_dv_date: lrCashAdvanceDvDate || null,
        amount_of_cash_advance: lrCashAdvanceAmount,
        refund_or_number: lrRefundOrNo || null,
        refund_or_date: lrRefundOrDate || null,
        amount_refunded: lrRefundAmount,
        amount_to_be_reimbursed: lrAmountToBeReimbursed,
        accountable_official_name: lrAccountableOfficial || null,
        accountable_official_date: lrAccountableDate || null,
        sk_chairperson_name: FIXED_SK_CHAIRPERSON,
        sk_chairperson_date: lrChairpersonDate || null,
        sk_treasurer_name: FIXED_SK_TREASURER,
        sk_treasurer_date: lrTreasurerDate || null,
        created_by: actor,
      };
    }

    const effectiveRerNo =
      (rerNumber ?? '').trim() ||
      generateUniqueDocNumber([...usedDocNumbers]);
    return {
      id: recordUuid,
      rer_number: effectiveRerNo,
      barangay: 'Kauswagan',
      city: 'Cagayan de Oro City',
      province: 'Misamis Oriental',
      rer_date: rerDate || new Date().toISOString().slice(0, 10),
      payee_name: rerPayeeName || 'Payee',
      official_designation: rerOfficialDesignation || 'SK Official',
      items: rerItems,
      total_amount: rerTotal,
      certified_by_name: FIXED_SK_TREASURER,
      certified_by_date: rerCertifiedDate || null,
      approved_by_name: FIXED_SK_CHAIRPERSON,
      approved_by_date: rerApprovedDate || null,
      created_by: actor,
    };
  };

  const handleSaveToSupabase = async (): Promise<DisbursementDbRecord[]> => {
    if (isOfflineNow()) {
      writeAutosaveNow();
      throw new Error(
        'No internet connection. Changes are saved locally in localStorage.'
      );
    }

    const resolvedFinalId = getDefaultFinalIdForCurrentTab();
    setFinalId(resolvedFinalId);

    const supabaseRow = buildSupabaseRowForTab();
    const { error } = await supabase
      .from(currentTabMeta.tableName as never)
      .upsert(supabaseRow as never, { onConflict: 'id' });

    if (error) {
      throw new Error(error.message);
    }

    const latestRecords = await loadDisbursementRecordsFromSupabase(false);
    showStatus(
      'success',
      'Saved to Supabase',
      `Saved (${resolvedFinalId}) to ${currentTabMeta.tableName}.`
    );
    return latestRecords;
  };

  const advanceNumbersAfterSave = (latestRecords: DisbursementDbRecord[]) => {
    const freshUuid = crypto.randomUUID();
    setRecordUuid(freshUuid);

    if (activeTab === 'dv') {
      const dbDvNos = latestRecords
        .filter((r) => r.docType === 'dv')
        .map((r) => r.finalId || r.payload?.dvNumber)
        .filter((v): v is string => Boolean(v));
      const nextDvNo = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbDvNos,
        dvNumber,
      ]);
      const freshItems: ParticularLineItem[] = [
        { id: `dv-${crypto.randomUUID()}`, particulars: '', amount: 0 },
      ];
      setUsedDocNumbers((prev) =>
        Array.from(new Set([...prev, ...dbDvNos, dvNumber, nextDvNo]))
      );
      setDvNumber(nextDvNo);
      setFinalId(nextDvNo);
      setDvItems(freshItems);
      writeAutosaveNow(freshUuid, {
        ...buildCurrentPayload(),
        dvNumber: nextDvNo,
        dvItems: freshItems,
      });
      return;
    }

    if (activeTab === 'certification') {
      const dbSkcNos = latestRecords
        .filter((r) => r.docType === 'certification')
        .map((r) => r.finalId || r.payload?.skcNumber)
        .filter((v): v is string => Boolean(v));
      const nextSkcNo = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbSkcNos,
        skcNumber,
      ]);
      const freshCheckItems: SkcCheckItem[] = [
        {
          id: `skc-${crypto.randomUUID()}`,
          accountNo: '',
          checkNo: '',
          date: '',
          payee: '',
          amount: 0,
          purpose: '',
        },
      ];
      setUsedDocNumbers((prev) =>
        Array.from(new Set([...prev, ...dbSkcNos, skcNumber, nextSkcNo]))
      );
      setSkcNumber(nextSkcNo);
      setFinalId(nextSkcNo);
      setSkcCheckItems(freshCheckItems);
      writeAutosaveNow(freshUuid, {
        ...buildCurrentPayload(),
        skcNumber: nextSkcNo,
        skcCheckItems: freshCheckItems,
      });
      return;
    }

    if (activeTab === 'liquidation') {
      const dbLrNos = latestRecords
        .filter((r) => r.docType === 'liquidation')
        .map((r) => r.finalId || r.payload?.lrNumber)
        .filter((v): v is string => Boolean(v));
      const nextLrNo = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbLrNos,
        lrNumber,
      ]);
      const freshItems: ParticularLineItem[] = [
        { id: `lr-${crypto.randomUUID()}`, particulars: '', amount: 0 },
      ];
      setUsedDocNumbers((prev) =>
        Array.from(new Set([...prev, ...dbLrNos, lrNumber, nextLrNo]))
      );
      setLrNumber(nextLrNo);
      setFinalId(nextLrNo);
      setLrItems(freshItems);
      setLrCashAdvanceAmount(0);
      setLrRefundAmount(0);
      writeAutosaveNow(freshUuid, {
        ...buildCurrentPayload(),
        lrNumber: nextLrNo,
        lrItems: freshItems,
        lrCashAdvanceAmount: 0,
        lrRefundAmount: 0,
      });
      return;
    }

    const dbRerNos = latestRecords
      .filter((r) => r.docType === 'rer')
      .map((r) => r.finalId || r.payload?.rerNumber)
      .filter((v): v is string => Boolean(v));
    const nextRerNo = generateUniqueDocNumber([
      ...usedDocNumbers,
      ...dbRerNos,
      rerNumber,
    ]);
    const freshRerItems: ParticularLineItem[] = [
      { id: `rer-${crypto.randomUUID()}`, particulars: '', amount: 0 },
    ];
    setUsedDocNumbers((prev) =>
      Array.from(new Set([...prev, ...dbRerNos, rerNumber, nextRerNo]))
    );
    setRerNumber(nextRerNo);
    setFinalId(nextRerNo);
    setRerItems(freshRerItems);
    writeAutosaveNow(freshUuid, {
      ...buildCurrentPayload(),
      rerNumber: nextRerNo,
      rerItems: freshRerItems,
    });
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

  const openEditDialog = (rec: DisbursementDbRecord) => {
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
        dvDate: p.activeTab === 'dv' ? nextDate : p.dvDate,
        dvPayeeName: p.activeTab === 'dv' ? nextTitle : p.dvPayeeName,
        skcDate: p.activeTab === 'certification' ? nextDate : p.skcDate,
        skcBankName: p.activeTab === 'certification' ? nextTitle : p.skcBankName,
        lrDate: p.activeTab === 'liquidation' ? nextDate : p.lrDate,
        lrAccountableOfficial:
          p.activeTab === 'liquidation' ? nextTitle : p.lrAccountableOfficial,
        rerDate: p.activeTab === 'rer' ? nextDate : p.rerDate,
        rerPayeeName: p.activeTab === 'rer' ? nextTitle : p.rerPayeeName,
      },
      rec.id
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

      await loadDisbursementRecordsFromSupabase(false);
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

  const renderParticularsTable = (
    items: ParticularLineItem[],
    setItems: React.Dispatch<React.SetStateAction<ParticularLineItem[]>>,
    prefix: string,
    label = 'Particulars & Amounts'
  ) => {
    const addRow = () =>
      setItems((prev) => [
        ...prev,
        { id: `${prefix}-${crypto.randomUUID()}`, particulars: '', amount: 0 },
      ]);

    const updateRow = <K extends keyof ParticularLineItem>(
      id: string,
      key: K,
      val: ParticularLineItem[K]
    ) =>
      setItems((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [key]: val } : r))
      );

    const removeRow = (id: string) =>
      setItems((prev) =>
        prev.length > 1 ? prev.filter((r) => r.id !== id) : prev
      );

    return (
      <div className="space-y-2 pt-2 border-t border-slate-200">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-800">
            {label} ({items.length})
          </span>
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Row</span>
          </button>
        </div>
        <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-slate-50 text-slate-700 border-b border-slate-200">
              <tr>
                <th className="px-2.5 py-2 text-left font-semibold">
                  Particulars
                </th>
                <th className="px-2 py-2 text-right font-semibold w-28">
                  Amount
                </th>
                <th className="px-2 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {items.map((row) => (
                <tr key={row.id}>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={row.particulars}
                      placeholder="Particulars"
                      onChange={(e) =>
                        updateRow(row.id, 'particulars', e.target.value)
                      }
                      onFocus={(e) =>
                        openFloatingInput(
                          e.currentTarget,
                          'text',
                          row.particulars,
                          (next) => updateRow(row.id, 'particulars', next)
                        )
                      }
                      className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      value={row.amount === 0 ? '' : row.amount}
                      placeholder="0.00"
                      onChange={(e) =>
                        updateRow(row.id, 'amount', Number(e.target.value))
                      }
                      onFocus={(e) =>
                        openFloatingInput(
                          e.currentTarget,
                          'number',
                          row.amount,
                          (next) => updateRow(row.id, 'amount', Number(next)),
                          'right'
                        )
                      }
                      className="w-full rounded border border-slate-300 px-2 py-1 text-right text-xs"
                    />
                  </td>
                  <td className="px-1.5 py-1.5 text-center">
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
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
      case 'dv':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label className="block text-xs font-medium text-slate-700">
                    DV No. (Auto)
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateNewNumberForCurrentTab}
                    className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                  >
                    + New DV No.
                  </button>
                </div>
                <input
                  type="text"
                  value={dvNumber}
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
                  value={dvDate}
                  onChange={(e) =>
                    setDvDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Payee
              </label>
              <input
                type="text"
                value={dvPayeeName}
                onChange={(e) => setDvPayeeName(e.target.value)}
                onFocus={(e) =>
                  openFloatingInput(
                    e.currentTarget,
                    'text',
                    dvPayeeName,
                    (next) => setDvPayeeName(next)
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
                  value={dvPayeeAddress}
                  onChange={(e) => setDvPayeeAddress(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  TIN
                </label>
                <input
                  type="text"
                  value={dvPayeeTin}
                  onChange={(e) => setDvPayeeTin(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            {renderParticularsTable(dvItems, setDvItems, 'dv')}

            <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-200">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Received By (Payee/Rep)
                </label>
                <input
                  type="text"
                  value={dvReceivedBy}
                  onChange={(e) => setDvReceivedBy(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Received Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={dvReceivedDate}
                  onChange={(e) =>
                    setDvReceivedDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Check No.
                </label>
                <input
                  type="text"
                  value={dvCheckNo}
                  onChange={(e) => setDvCheckNo(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Check Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={dvCheckDate}
                  onChange={(e) =>
                    setDvCheckDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Bank Name
                </label>
                <input
                  type="text"
                  value={dvBankName}
                  onChange={(e) => setDvBankName(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Bank Branch
                </label>
                <input
                  type="text"
                  value={dvBankBranch}
                  onChange={(e) => setDvBankBranch(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  OR No.
                </label>
                <input
                  type="text"
                  value={dvOrNo}
                  onChange={(e) => setDvOrNo(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  OR Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={dvOrDate}
                  onChange={(e) =>
                    setDvOrDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
            </div>
          </div>
        );

      case 'certification': {
        const addSkcRow = () =>
          setSkcCheckItems((prev) => [
            ...prev,
            {
              id: `skc-${crypto.randomUUID()}`,
              accountNo: '',
              checkNo: '',
              date: '',
              payee: '',
              amount: 0,
              purpose: '',
            },
          ]);
        const updateSkcRow = <K extends keyof SkcCheckItem>(
          id: string,
          key: K,
          val: SkcCheckItem[K]
        ) =>
          setSkcCheckItems((prev) =>
            prev.map((r) => (r.id === id ? { ...r, [key]: val } : r))
          );
        const removeSkcRow = (id: string) =>
          setSkcCheckItems((prev) =>
            prev.length > 1 ? prev.filter((r) => r.id !== id) : prev
          );

        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label className="block text-xs font-medium text-slate-700">
                    SKCC No. (Auto)
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateNewNumberForCurrentTab}
                    className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                  >
                    + New SKCC No.
                  </button>
                </div>
                <input
                  type="text"
                  value={skcNumber}
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
                  value={skcDate}
                  onChange={(e) =>
                    setSkcDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Bank Name
                </label>
                <input
                  type="text"
                  value={skcBankName}
                  onChange={(e) => setSkcBankName(e.target.value)}
                  onFocus={(e) =>
                    openFloatingInput(
                      e.currentTarget,
                      'text',
                      skcBankName,
                      (next) => setSkcBankName(next)
                    )
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Bank Address
                </label>
                <input
                  type="text"
                  value={skcBankAddress}
                  onChange={(e) => setSkcBankAddress(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">
                  Issued Checks ({skcCheckItems.length})
                </span>
                <button
                  type="button"
                  onClick={addSkcRow}
                  className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Row</span>
                </button>
              </div>
              <div className="max-h-60 overflow-y-auto overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-slate-50 text-slate-700 border-b border-slate-200">
                    <tr>
                      <th className="px-2 py-2 text-left font-semibold">
                        Acct No.
                      </th>
                      <th className="px-2 py-2 text-left font-semibold">
                        Check No.
                      </th>
                      <th className="px-2 py-2 text-left font-semibold">
                        Date
                      </th>
                      <th className="px-2 py-2 text-left font-semibold">
                        Payee
                      </th>
                      <th className="px-2 py-2 text-right font-semibold">
                        Amount
                      </th>
                      <th className="px-2 py-2 text-left font-semibold">
                        Purpose
                      </th>
                      <th className="px-2 py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {skcCheckItems.map((row) => (
                      <tr key={row.id}>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            value={row.accountNo}
                            onChange={(e) =>
                              updateSkcRow(row.id, 'accountNo', e.target.value)
                            }
                            className="w-20 rounded border border-slate-300 px-1.5 py-1 text-xs"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            value={row.checkNo}
                            onChange={(e) =>
                              updateSkcRow(row.id, 'checkNo', e.target.value)
                            }
                            className="w-20 rounded border border-slate-300 px-1.5 py-1 text-xs"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            placeholder="YYYY-MM-DD"
                            value={row.date}
                            onChange={(e) =>
                              updateSkcRow(
                                row.id,
                                'date',
                                formatAutoDashDate(e.target.value)
                              )
                            }
                            className="w-24 rounded border border-slate-300 px-1.5 py-1 text-xs"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            value={row.payee}
                            onChange={(e) =>
                              updateSkcRow(row.id, 'payee', e.target.value)
                            }
                            className="w-28 rounded border border-slate-300 px-1.5 py-1 text-xs"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="number"
                            value={row.amount === 0 ? '' : row.amount}
                            onChange={(e) =>
                              updateSkcRow(row.id, 'amount', Number(e.target.value))
                            }
                            className="w-24 rounded border border-slate-300 px-1.5 py-1 text-right text-xs"
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <input
                            type="text"
                            value={row.purpose}
                            onChange={(e) =>
                              updateSkcRow(row.id, 'purpose', e.target.value)
                            }
                            className="w-28 rounded border border-slate-300 px-1.5 py-1 text-xs"
                          />
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          {skcCheckItems.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeSkcRow(row.id)}
                              className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
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

            <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-200">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Delivery Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={skcDeliveredDate}
                  onChange={(e) =>
                    setSkcDeliveredDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Received By (Bank Rep)
                </label>
                <input
                  type="text"
                  value={skcReceivedBy}
                  onChange={(e) => setSkcReceivedBy(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Received Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={skcReceivedDate}
                  onChange={(e) =>
                    setSkcReceivedDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
            </div>
          </div>
        );
      }

      case 'liquidation': {
        const accountableChoices =
          lrAccountableOfficial &&
          !ACCOUNTABLE_OFFICIAL_OPTIONS.includes(lrAccountableOfficial)
            ? [lrAccountableOfficial, ...ACCOUNTABLE_OFFICIAL_OPTIONS]
            : ACCOUNTABLE_OFFICIAL_OPTIONS;

        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label className="block text-xs font-medium text-slate-700">
                    LR No. (Auto)
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateNewNumberForCurrentTab}
                    className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                  >
                    + New LR No.
                  </button>
                </div>
                <input
                  type="text"
                  value={lrNumber}
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
                  value={lrDate}
                  onChange={(e) =>
                    setLrDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            {renderParticularsTable(lrItems, setLrItems, 'lr')}

            <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-200">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Cash Advance DV No.
                </label>
                <input
                  type="text"
                  value={lrCashAdvanceDvNo}
                  onChange={(e) => setLrCashAdvanceDvNo(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Cash Advance DV Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={lrCashAdvanceDvDate}
                  onChange={(e) =>
                    setLrCashAdvanceDvDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Cash Advance Amount
                </label>
                <input
                  type="number"
                  value={lrCashAdvanceAmount === 0 ? '' : lrCashAdvanceAmount}
                  onChange={(e) =>
                    setLrCashAdvanceAmount(Number(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-right text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Refund O.R. No.
                </label>
                <input
                  type="text"
                  value={lrRefundOrNo}
                  onChange={(e) => setLrRefundOrNo(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Refund O.R. Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={lrRefundOrDate}
                  onChange={(e) =>
                    setLrRefundOrDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Amount Refunded
                </label>
                <input
                  type="number"
                  value={lrRefundAmount === 0 ? '' : lrRefundAmount}
                  onChange={(e) => setLrRefundAmount(Number(e.target.value))}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-right text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Accountable SK Official
                </label>
                <select
                  value={lrAccountableOfficial}
                  onChange={(e) => setLrAccountableOfficial(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800"
                >
                  {accountableChoices.map((official) => (
                    <option key={official} value={official}>
                      {official}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Accountable Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={lrAccountableDate}
                  onChange={(e) =>
                    setLrAccountableDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Chairperson Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={lrChairpersonDate}
                  onChange={(e) =>
                    setLrChairpersonDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Treasurer Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={lrTreasurerDate}
                  onChange={(e) =>
                    setLrTreasurerDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
            </div>
          </div>
        );
      }

      case 'rer':
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between gap-1">
                  <label className="block text-xs font-medium text-slate-700">
                    RER No. (Auto)
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateNewNumberForCurrentTab}
                    className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                  >
                    + New RER No.
                  </button>
                </div>
                <input
                  type="text"
                  value={rerNumber}
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
                  value={rerDate}
                  onChange={(e) =>
                    setRerDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Payee / Claimant
                </label>
                <input
                  type="text"
                  value={rerPayeeName}
                  onChange={(e) => setRerPayeeName(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Designation
                </label>
                <input
                  type="text"
                  value={rerOfficialDesignation}
                  onChange={(e) => setRerOfficialDesignation(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            {renderParticularsTable(
              rerItems,
              setRerItems,
              'rer',
              'Nature of Expense & Amount'
            )}

            <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-200">
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Certified Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={rerCertifiedDate}
                  onChange={(e) =>
                    setRerCertifiedDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700">
                  Approved Date
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY-MM-DD"
                  value={rerApprovedDate}
                  onChange={(e) =>
                    setRerApprovedDate(formatAutoDashDate(e.target.value))
                  }
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
            </div>
          </div>
        );
    }
  };

  const renderPaperSheetFromData = (data: {
    activeTab: DisbursementTabKey;
    dvNumber: string;
    dvDate: string;
    dvPayeeName: string;
    dvPayeeAddress: string;
    dvPayeeTin: string;
    dvItems: ParticularLineItem[];
    dvReceivedBy: string;
    dvReceivedDate: string;
    dvCheckNo: string;
    dvCheckDate: string;
    dvBankName: string;
    dvBankBranch: string;
    dvOrNo: string;
    dvOrDate: string;
    skcNumber: string;
    skcDate: string;
    skcBankTitle: string;
    skcBankName: string;
    skcBankAddress: string;
    skcCheckItems: SkcCheckItem[];
    skcDeliveredDate: string;
    skcReceivedBy: string;
    skcReceivedDate: string;
    lrNumber: string;
    lrDate: string;
    lrItems: ParticularLineItem[];
    lrCashAdvanceDvNo: string;
    lrCashAdvanceDvDate: string;
    lrCashAdvanceAmount: number;
    lrRefundOrNo: string;
    lrRefundOrDate: string;
    lrRefundAmount: number;
    lrAccountableOfficial: string;
    lrAccountableDate: string;
    lrChairpersonDate: string;
    lrTreasurerDate: string;
    rerNumber: string;
    rerDate: string;
    rerPayeeName: string;
    rerOfficialDesignation: string;
    rerItems: ParticularLineItem[];
    rerCertifiedDate: string;
    rerApprovedDate: string;
  }) => {
    const tabTotalSpent = data.lrItems.reduce((sum, r) => sum + r.amount, 0);
    const tabReimbursed = Math.max(
      0,
      tabTotalSpent - data.lrCashAdvanceAmount - data.lrRefundAmount
    );
    const tabRerTotal = data.rerItems.reduce((sum, r) => sum + r.amount, 0);

    switch (data.activeTab) {
      case 'dv':
        return (
          <div className="text-xs text-slate-900">
            <div className="border border-black">
              <div className="border-b border-black py-2.5 text-center">
                <p className="text-sm font-bold uppercase tracking-wide">
                  DISBURSEMENT VOUCHER
                </p>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px]">
                <div className="col-span-8 border-r border-black divide-y divide-black">
                  <div className="px-2 py-1">
                    SK of Barangay: <strong>Kauswagan</strong>
                  </div>
                  <div className="px-2 py-1">
                    City/Municipality: <strong>Cagayan de Oro City</strong>
                  </div>
                  <div className="px-2 py-1">
                    Province: <strong>Misamis Oriental</strong>
                  </div>
                  <div className="px-2 py-1">
                    Payee: <strong>{data.dvPayeeName}</strong>
                  </div>
                  <div className="px-2 py-1">
                    Address: <strong>{data.dvPayeeAddress}</strong>
                  </div>
                  <div className="px-2 py-1">
                    TIN: <strong>{data.dvPayeeTin}</strong>
                  </div>
                </div>
                <div className="col-span-4 divide-y divide-black">
                  <div className="px-2 py-1">
                    DV No.: <strong>{data.dvNumber}</strong>
                  </div>
                  <div className="px-2 py-1">
                    Date : <strong>{data.dvDate}</strong>
                  </div>
                  <div className="px-2 py-1">&nbsp;</div>
                  <div className="px-2 py-1">&nbsp;</div>
                  <div className="px-2 py-1">&nbsp;</div>
                  <div className="px-2 py-1">&nbsp;</div>
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px] font-bold text-center">
                <div className="col-span-9 border-r border-black py-1">
                  Particulars
                </div>
                <div className="col-span-3 py-1">Amount</div>
              </div>

              <div className="grid grid-cols-12 border-b border-black min-h-56 text-[11px]">
                <div className="col-span-9 border-r border-black p-2 space-y-1">
                  {data.dvItems.map((it) => (
                    <p key={it.id}>{it.particulars}</p>
                  ))}
                </div>
                <div className="col-span-3 p-2 space-y-1 text-right">
                  {data.dvItems.map((it) => (
                    <p key={it.id}>
                      {it.amount ? formatNumber(it.amount) : ''}
                    </p>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 border-b border-black text-[11px]">
                <div className="border-r border-black p-2 flex flex-col justify-between min-h-36">
                  <p>
                    <strong>A. Certified</strong> as to availability of the
                    budget or funds received for specific purpose
                  </p>
                  <div className="text-center pt-6">
                    <p className="font-bold underline uppercase">
                      {FIXED_BUDGET_OFFICER}
                    </p>
                    <p className="text-[10px]">
                      (Signature Over Printed Name)
                    </p>
                    <p className="text-[10px]">Budget Monitoring Officer</p>
                  </div>
                </div>

                <div className="border-r border-black p-2 flex flex-col justify-between min-h-36">
                  <p>
                    <strong>B. Certified</strong> as to availability of cash,
                    and completeness and propriety of supporting documents
                  </p>
                  <div className="text-center pt-6">
                    <p className="font-bold underline uppercase">
                      {FIXED_SK_TREASURER}
                    </p>
                    <p className="text-[10px]">
                      (Signature Over Printed Name)
                    </p>
                    <p className="text-[10px]">SK Treasurer</p>
                  </div>
                </div>

                <div className="p-2 flex flex-col justify-between min-h-36">
                  <p>
                    <strong>C. Certified</strong> as to necessity, validity,
                    propriety, and legality of claim; and <strong>Approved</strong>{' '}
                    for payment:
                  </p>
                  <div className="text-center pt-6">
                    <p className="font-bold underline uppercase">
                      {FIXED_SK_CHAIRPERSON}
                    </p>
                    <p className="text-[10px]">
                      (Signature Over Printed Name)
                    </p>
                    <p className="text-[10px]">SK Chairperson</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 border-b border-black text-[11px] py-1">
                <div className="px-2">
                  Date : <span>{data.dvDate}</span>
                </div>
                <div className="px-2">
                  Date : <span>{data.dvDate}</span>
                </div>
                <div className="px-2">
                  Date : <span>{data.dvDate}</span>
                </div>
              </div>

              <div className="grid grid-cols-12 text-[11px]">
                <div className="col-span-7 border-r border-black p-2 flex flex-col justify-between">
                  <p className="font-bold">D. Received Payment:</p>
                  <div className="text-center pt-6 space-y-1">
                    <p className="font-bold underline uppercase">
                      {data.dvReceivedBy}
                    </p>
                    <p className="text-[10px]">
                      Signature Over Printed Name of Payee/ Authorized
                      Representative
                    </p>
                    <p className="text-[10px] pt-2">
                      Date: <span>{data.dvReceivedDate}</span>
                    </p>
                  </div>
                </div>
                <div className="col-span-5 divide-y divide-black">
                  <div className="px-2 py-1">
                    Check No.: <strong>{data.dvCheckNo}</strong>
                  </div>
                  <div className="px-2 py-1">
                    Date: <strong>{data.dvCheckDate}</strong>
                  </div>
                  <div className="px-2 py-1">
                    Bank Name: <strong>{data.dvBankName}</strong>
                  </div>
                  <div className="px-2 py-1">
                    Bank Branch: <strong>{data.dvBankBranch}</strong>
                  </div>
                  <div className="px-2 py-1">
                    OR No.: <strong>{data.dvOrNo}</strong>
                  </div>
                  <div className="px-2 py-1">
                    Date: <strong>{data.dvOrDate}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      case 'certification':
        return (
          <div className="text-xs text-slate-900 space-y-3 leading-relaxed">
            <p className="text-right text-[11px] font-medium">Annex 8</p>
            <div className="text-center leading-snug space-y-0.5">
              <p>
                SK of Barangay <strong>Kauswagan</strong>
              </p>
              <p>
                City/Municipality <strong>Cagayan de Oro City</strong>
              </p>
              <p>
                Province <strong>Misamis Oriental</strong>
              </p>
              <p className="pt-2 text-sm font-bold uppercase">
                SK CHAIRPERSON&apos;S CERTIFICATION
              </p>
            </div>

            <div className="flex justify-end text-[11px]">
              <div className="space-y-0.5">
                <p>
                  SKCC No.: <strong>{data.skcNumber}</strong>
                </p>
                <p>
                  Date: <strong>{data.skcDate}</strong>
                </p>
              </div>
            </div>

            <div className="text-[11px] space-y-0.5">
              <p className="font-bold">
                To: {data.skcBankTitle || 'The Bank Manager'}
              </p>
              <p className="pl-6">
                {data.skcBankName || '(Name of Bank)'}
              </p>
              <p className="pl-6">
                {data.skcBankAddress || '(Address)'}
              </p>
            </div>

            <p className="font-bold italic text-[11px]">Sir/Madam:</p>

            <p className="text-[11px] indent-8">
              This is to certify that the following checks were duly issued by SK
              of Barangay <strong>Kauswagan</strong>,
              <br />
              <span className="italic text-[10px]">
                (Ito ay pagpapatunay na ang mga tseke na nakalista sa ibaba ay
                na-isyu ng SK ng Barangay Kauswagan,
              </span>
            </p>

            <p className="text-[11px]">
              complete with respective Disbursement Vouchers and supporting
              documents.
              <br />
              <span className="italic text-[10px]">
                na kompleto ng kani-kanilang Disbursement Vouchers at kalakip na
                mga dokumento.)
              </span>
            </p>

            <table className="w-full border-collapse border border-black text-[11px]">
              <thead>
                <tr className="font-bold text-center">
                  <th className="border border-black px-1.5 py-1">
                    Account No.
                  </th>
                  <th className="border border-black px-1.5 py-1">Check No.</th>
                  <th className="border border-black px-1.5 py-1">Date</th>
                  <th className="border border-black px-1.5 py-1">Payee</th>
                  <th className="border border-black px-1.5 py-1">Amount</th>
                  <th className="border border-black px-1.5 py-1">Purpose</th>
                </tr>
              </thead>
              <tbody>
                {data.skcCheckItems.map((row) => (
                  <tr key={row.id}>
                    <td className="border border-black px-1.5 py-1 text-center">
                      {row.accountNo}
                    </td>
                    <td className="border border-black px-1.5 py-1 text-center">
                      {row.checkNo}
                    </td>
                    <td className="border border-black px-1.5 py-1 text-center">
                      {row.date}
                    </td>
                    <td className="border border-black px-1.5 py-1">
                      {row.payee}
                    </td>
                    <td className="border border-black px-1.5 py-1 text-right">
                      {row.amount ? formatNumber(row.amount) : ''}
                    </td>
                    <td className="border border-black px-1.5 py-1">
                      {row.purpose}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="text-[11px] indent-8">
              The undersigned attests to the truthfulness of the foregoing facts,
              under pain of
              <br />
              <span className="italic text-[10px]">
                (Pinapatotohanan ng may lagda ang mga nakasaad sa itaas batid
                ang
              </span>
            </p>

            <p className="text-[11px]">
              liability for falsification, pursuant to Article 171(4) of the
              Revised Penal Code of the Philippines.
              <br />
              <span className="italic text-[10px]">
                pananagutan sa kasong &ldquo;Falsification&rdquo;, sang-ayon sa
                Artikulo 171(4) ng Revised Penal Code ng Pilipinas.)
              </span>
            </p>

            <div className="flex justify-end pt-4 pr-6 text-[11px]">
              <div className="text-center space-y-5">
                <p>Very truly yours,</p>
                <div>
                  <p className="font-bold underline uppercase">
                    {FIXED_SK_CHAIRPERSON}
                  </p>
                  <p className="font-bold">SK Chairperson</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-8 pt-4 text-[11px]">
              <div className="space-y-4">
                <p>Delivered by:</p>
                <div className="text-center">
                  <p className="font-bold underline uppercase">
                    {FIXED_SK_TREASURER}
                  </p>
                  <p className="font-bold">SK Treasurer</p>
                  <p className="text-left pt-1">
                    Date: <span>{data.skcDeliveredDate}</span>
                  </p>
                </div>
              </div>
              <div className="space-y-4">
                <p>Received by:</p>
                <div className="text-center">
                  <p className="font-bold underline uppercase">
                    {data.skcReceivedBy}
                  </p>
                  <p className="font-bold">Bank Representative</p>
                  <p className="text-left pt-1">
                    Date: <span>{data.skcReceivedDate}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        );

      case 'liquidation':
        return (
          <div className="text-xs text-slate-900">
            <div className="border border-black">
              <div className="grid grid-cols-12 border-b border-black text-[11px]">
                <div className="col-span-8 border-r border-black py-2 px-3 text-center">
                  <p className="text-sm font-bold uppercase tracking-wide">
                    LIQUIDATION REPORT
                  </p>
                  <p className="mt-1 font-medium">
                    Kauswagan, Cagayan de Oro City, Misamis Oriental
                  </p>
                  <p className="italic text-[10px]">
                    SK of Barangay, City/Municipality, Province
                  </p>
                </div>
                <div className="col-span-4 divide-y divide-black">
                  <div className="px-2 py-2.5">
                    LR No.: <strong>{data.lrNumber}</strong>
                  </div>
                  <div className="px-2 py-2.5">
                    Date: <strong>{data.lrDate}</strong>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px] font-bold uppercase text-center">
                <div className="col-span-9 border-r border-black py-1">
                  PARTICULARS
                </div>
                <div className="col-span-3 py-1">AMOUNT</div>
              </div>

              <div className="grid grid-cols-12 border-b border-black min-h-60 text-[11px]">
                <div className="col-span-9 border-r border-black p-2 space-y-1">
                  {data.lrItems.map((it) => (
                    <p key={it.id}>{it.particulars}</p>
                  ))}
                </div>
                <div className="col-span-3 p-2 space-y-1 text-right">
                  {data.lrItems.map((it) => (
                    <p key={it.id}>
                      {it.amount ? formatNumber(it.amount) : ''}
                    </p>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px] font-medium">
                <div className="col-span-9 border-r border-black px-2 py-1 flex items-center justify-between">
                  <span>TOTAL AMOUNT SPENT</span>
                  <span>➔</span>
                </div>
                <div className="col-span-3 px-2 py-1 text-right font-bold">
                  {tabTotalSpent ? formatNumber(tabTotalSpent) : ''}
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px] font-medium">
                <div className="col-span-9 border-r border-black px-2 py-1 flex items-center justify-between">
                  <span>
                    AMOUNT OF CASH ADVANCE PER DV NO.{' '}
                    <span>{data.lrCashAdvanceDvNo || '______'}</span> DTD.{' '}
                    <span>{data.lrCashAdvanceDvDate || '______'}</span>
                  </span>
                  <span>➔</span>
                </div>
                <div className="col-span-3 px-2 py-1 text-right">
                  {data.lrCashAdvanceAmount
                    ? formatNumber(data.lrCashAdvanceAmount)
                    : ''}
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px] font-medium">
                <div className="col-span-9 border-r border-black px-2 py-1 flex items-center justify-between">
                  <span>
                    AMOUNT REFUNDED PER O.R. NO.{' '}
                    <span>{data.lrRefundOrNo || '______'}</span> DTD.{' '}
                    <span>{data.lrRefundOrDate || '______'}</span>
                  </span>
                  <span>➔</span>
                </div>
                <div className="col-span-3 px-2 py-1 text-right">
                  {data.lrRefundAmount
                    ? formatNumber(data.lrRefundAmount)
                    : ''}
                </div>
              </div>

              <div className="grid grid-cols-12 border-b border-black text-[11px] font-medium">
                <div className="col-span-9 border-r border-black px-2 py-1 flex items-center justify-between">
                  <span>AMOUNT TO BE REIMBURSED</span>
                  <span>➔</span>
                </div>
                <div className="col-span-3 px-2 py-1 text-right font-bold">
                  {tabReimbursed ? formatNumber(tabReimbursed) : ''}
                </div>
              </div>

              <div className="grid grid-cols-3 text-[11px]">
                <div className="border-r border-black p-2 flex flex-col justify-between min-h-40">
                  <p>
                    <strong>A. Certified</strong>: Correctness of the above
                    data
                  </p>
                  <div className="text-center space-y-2 pt-6">
                    <div>
                      <p className="font-bold underline uppercase">
                        {data.lrAccountableOfficial}
                      </p>
                      <p className="text-[10px]">
                        Signature over Printed Name
                      </p>
                      <p className="text-[10px]">Accountable SK Official</p>
                    </div>
                    <div>
                      <p className="text-[10px]">
                        {data.lrAccountableDate || '____________'}
                      </p>
                      <p className="text-[10px]">Date</p>
                    </div>
                  </div>
                </div>

                <div className="border-r border-black p-2 flex flex-col justify-between min-h-40">
                  <p>
                    <strong>B. Certified</strong>: Purpose of cash advance duly
                    accomplished
                  </p>
                  <div className="text-center space-y-2 pt-6">
                    <div>
                      <p className="font-bold underline uppercase">
                        {FIXED_SK_CHAIRPERSON}
                      </p>
                      <p className="text-[10px]">
                        Signature over Printed Name
                      </p>
                      <p className="text-[10px]">SK Chairperson</p>
                    </div>
                    <div>
                      <p className="text-[10px]">
                        {data.lrChairpersonDate || '____________'}
                      </p>
                      <p className="text-[10px]">Date</p>
                    </div>
                  </div>
                </div>

                <div className="p-2 flex flex-col justify-between min-h-40">
                  <p>
                    <strong>C. Certified</strong>: Supporting documents are
                    complete and proper
                  </p>
                  <div className="text-center space-y-2 pt-6">
                    <div>
                      <p className="font-bold underline uppercase">
                        {FIXED_SK_TREASURER}
                      </p>
                      <p className="text-[10px]">
                        Signature over Printed Name
                      </p>
                      <p className="text-[10px]">SK Treasurer</p>
                    </div>
                    <div>
                      <p className="text-[10px]">
                        {data.lrTreasurerDate || '____________'}
                      </p>
                      <p className="text-[10px]">Date</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      case 'rer':
        return (
          <div className="text-xs text-slate-900 space-y-4">
            <div className="text-center leading-snug space-y-0.5">
              <p className="text-xs">Republic of the Philippines</p>
              <p className="text-xs">City of Cagayan de Oro</p>
              <p className="text-xs font-bold uppercase">
                SK BARANGAY KAUSWAGAN
              </p>
              <p className="pt-1 text-sm font-bold uppercase">
                REIMBURSEMENT EXPENSE RECEIPT (RER)
              </p>
            </div>

            <div className="flex justify-between text-[11px]">
              <div className="space-y-0.5">
                <p>
                  Payee:{' '}
                  <strong>{data.rerPayeeName || '________________'}</strong>
                </p>
                <p>
                  Designation:{' '}
                  <strong>
                    {data.rerOfficialDesignation || 'SK Official'}
                  </strong>
                </p>
              </div>
              <div className="space-y-0.5">
                <p>
                  RER No.: <strong>{data.rerNumber}</strong>
                </p>
                <p>
                  Date: <strong>{data.rerDate}</strong>
                </p>
              </div>
            </div>

            <table className="w-full border-collapse border border-black text-[11px]">
              <thead>
                <tr className="font-bold uppercase text-center">
                  <th className="border border-black px-2 py-1.5 text-left">
                    Nature of Expense
                  </th>
                  <th className="border border-black px-2 py-1.5 text-right w-32">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rerItems.map((it) => (
                  <tr key={it.id}>
                    <td className="border border-black px-2 py-1.5">
                      {it.particulars}
                    </td>
                    <td className="border border-black px-2 py-1.5 text-right">
                      {it.amount ? formatNumber(it.amount) : ''}
                    </td>
                  </tr>
                ))}
                <tr className="font-bold">
                  <td className="border border-black px-2 py-1.5 text-right">
                    TOTAL
                  </td>
                  <td className="border border-black px-2 py-1.5 text-right">
                    Php {tabRerTotal ? formatNumber(tabRerTotal) : '0.00'}
                  </td>
                </tr>
              </tbody>
            </table>

            <p className="text-[11px] leading-relaxed">
              I hereby certify that the expenses listed above were incurred by me
              in the performance of official SK duties and that receipts could
              not be obtained under the circumstances.
            </p>

            <div className="grid grid-cols-2 gap-8 pt-6 text-center text-[11px]">
              <div className="space-y-5">
                <p className="text-left font-medium">Certified Correct:</p>
                <div>
                  <p className="font-bold underline uppercase">
                    {FIXED_SK_TREASURER}
                  </p>
                  <p>SK Treasurer</p>
                  <p className="text-[10px] pt-1">
                    Date: <span>{data.rerCertifiedDate}</span>
                  </p>
                </div>
              </div>
              <div className="space-y-5">
                <p className="text-left font-medium">Approved for Payment:</p>
                <div>
                  <p className="font-bold underline uppercase">
                    {FIXED_SK_CHAIRPERSON}
                  </p>
                  <p>SK Chairperson</p>
                  <p className="text-[10px] pt-1">
                    Date: <span>{data.rerApprovedDate}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
    }
  };

  const renderPaperSheetContent = () =>
    renderPaperSheetFromData({
      activeTab,
      dvNumber,
      dvDate,
      dvPayeeName,
      dvPayeeAddress,
      dvPayeeTin,
      dvItems,
      dvReceivedBy,
      dvReceivedDate,
      dvCheckNo,
      dvCheckDate,
      dvBankName,
      dvBankBranch,
      dvOrNo,
      dvOrDate,
      skcNumber,
      skcDate,
      skcBankTitle,
      skcBankName,
      skcBankAddress,
      skcCheckItems,
      skcDeliveredDate,
      skcReceivedBy,
      skcReceivedDate,
      lrNumber,
      lrDate,
      lrItems,
      lrCashAdvanceDvNo,
      lrCashAdvanceDvDate,
      lrCashAdvanceAmount,
      lrRefundOrNo,
      lrRefundOrDate,
      lrRefundAmount,
      lrAccountableOfficial,
      lrAccountableDate,
      lrChairpersonDate,
      lrTreasurerDate,
      rerNumber,
      rerDate,
      rerPayeeName,
      rerOfficialDesignation,
      rerItems,
      rerCertifiedDate,
      rerApprovedDate,
    });

  const renderRecordDocumentPreview = (rec: DisbursementDbRecord) => {
    const p = rec.payload;
    const recDocType: DisbursementTabKey = p?.activeTab || rec.docType;
    const recPaperSize: PaperSizeKey = p?.paperSize || 'a4';
    const recOrientation: PaperOrientation = p?.orientation || 'portrait';
    const spec = PAPER_DIMENSIONS[recPaperSize];
    const widthMm =
      recOrientation === 'portrait' ? spec.widthMm : spec.heightMm;
    const minHeightMm =
      recOrientation === 'portrait' ? spec.heightMm : spec.widthMm;

    return (
      <div {...panHandlers} className={`overflow-x-auto rounded-lg bg-slate-200/80 p-4 ${isDraggingPreview ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
        <div
          style={{
            width: `${widthMm}mm`,
            minHeight: `${minHeightMm}mm`,
            padding: '12mm',
          }}
          className="mx-auto bg-white text-slate-900 shadow-lg ring-1 ring-slate-900/10"
        >
          {renderPaperSheetFromData({
            activeTab: recDocType,
            dvNumber: p.dvNumber || rec.finalId,
            dvDate: p.dvDate || rec.dateText || '',
            dvPayeeName:
              p.dvPayeeName || (recDocType === 'dv' ? rec.title : ''),
            dvPayeeAddress: p.dvPayeeAddress || '',
            dvPayeeTin: p.dvPayeeTin || '',
            dvItems: Array.isArray(p.dvItems) ? p.dvItems : [],
            dvReceivedBy: p.dvReceivedBy || '',
            dvReceivedDate: p.dvReceivedDate || '',
            dvCheckNo: p.dvCheckNo || '',
            dvCheckDate: p.dvCheckDate || '',
            dvBankName: p.dvBankName || '',
            dvBankBranch: p.dvBankBranch || '',
            dvOrNo: p.dvOrNo || '',
            dvOrDate: p.dvOrDate || '',
            skcNumber: p.skcNumber || rec.finalId,
            skcDate: p.skcDate || rec.dateText || '',
            skcBankTitle: p.skcBankTitle || 'The Bank Manager',
            skcBankName:
              p.skcBankName || (recDocType === 'certification' ? rec.title : ''),
            skcBankAddress: p.skcBankAddress || '',
            skcCheckItems: Array.isArray(p.skcCheckItems)
              ? p.skcCheckItems
              : [],
            skcDeliveredDate: p.skcDeliveredDate || '',
            skcReceivedBy: p.skcReceivedBy || '',
            skcReceivedDate: p.skcReceivedDate || '',
            lrNumber: p.lrNumber || rec.finalId,
            lrDate: p.lrDate || rec.dateText || '',
            lrItems: Array.isArray(p.lrItems) ? p.lrItems : [],
            lrCashAdvanceDvNo: p.lrCashAdvanceDvNo || '',
            lrCashAdvanceDvDate: p.lrCashAdvanceDvDate || '',
            lrCashAdvanceAmount: Number(p.lrCashAdvanceAmount || 0),
            lrRefundOrNo: p.lrRefundOrNo || '',
            lrRefundOrDate: p.lrRefundOrDate || '',
            lrRefundAmount: Number(p.lrRefundAmount || 0),
            lrAccountableOfficial:
              p.lrAccountableOfficial ||
              (recDocType === 'liquidation' ? rec.title : ''),
            lrAccountableDate: p.lrAccountableDate || '',
            lrChairpersonDate: p.lrChairpersonDate || '',
            lrTreasurerDate: p.lrTreasurerDate || '',
            rerNumber: p.rerNumber || rec.finalId,
            rerDate: p.rerDate || rec.dateText || '',
            rerPayeeName:
              p.rerPayeeName || (recDocType === 'rer' ? rec.title : ''),
            rerOfficialDesignation: p.rerOfficialDesignation || 'SK Official',
            rerItems: Array.isArray(p.rerItems) ? p.rerItems : [],
            rerCertifiedDate: p.rerCertifiedDate || '',
            rerApprovedDate: p.rerApprovedDate || '',
          })}
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
                    <th className="px-3 py-2 text-left font-semibold">Form</th>
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
                        colSpan={5}
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
                        <td className="px-3 py-2 uppercase text-[11px] font-semibold text-slate-700">
                          {rec.docType}
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
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Load Record into Editor ({editingRecord.finalId || 'Record'})
              </h3>
              <button
                type="button"
                onClick={() => setEditingRecord(null)}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Title / Payee / Bank
                </label>
                <input
                  type="text"
                  value={editTitleDraft}
                  onChange={(e) => setEditTitleDraft(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
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

            <div className="flex justify-end gap-2 pt-2">
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
            <h3 className="text-sm font-semibold text-slate-900">
              Delete Record?
            </h3>
            <p className="text-xs text-slate-600">
              Are you sure you want to delete{' '}
              <strong>{deletingRecord.finalId || deletingRecord.title}</strong>{' '}
              from <code>{deletingRecord.tableName}</code>? This cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
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
                className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50 cursor-pointer"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <StatusDialog
        dialog={statusDialog}
        onClose={closeStatusDialog}
        onRetry={
          statusDialog.isOffline
            ? () => {
                if (!isOfflineNow()) {
                  closeStatusDialog();
                  void loadDisbursementRecordsFromSupabase(false);
                } else {
                  showNoInternetDialog();
                }
              }
            : undefined
        }
      />

      <PageTabs
        tabs={TABS.map(({ key, label }) => ({ key, label }))}
        activeTab={activeTab}
        onChange={(key) => setActiveTab(key as DisbursementTabKey)}
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
                  setViewingRecord(false);
                  setEditing(false);
                  setIsDatabaseDialogOpen(false);
                }}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                title="Start a new record using the current form values as a starting copy"
              >
                New
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={requestSaveConfirmation}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50 transition cursor-pointer"
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

        <div className="xl:col-span-8 space-y-4">
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
                void (async () => {
                  if (isOfflineNow()) {
                    showNoInternetDialog();
                    return;
                  }
                  try {
                    await loadDisbursementRecordsFromSupabase(false);
                    setIsDatabaseDialogOpen(true);
                  } catch (err) {
                    showStatus(
                      'error',
                      'Database Unavailable',
                      'Could not load records from Supabase.',
                      err instanceof Error ? err.message : undefined
                    );
                  }
                })();
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

          <div ref={previewPanViewportRef} {...panHandlers} className={`overflow-auto rounded-xl border border-slate-300/80 bg-slate-200/80 p-6 print:overflow-visible print:rounded-none print:border-none print:bg-transparent print:p-0 ${isDraggingPreview ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
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
                  className="flex flex-col items-center justify-center gap-2 bg-white px-8 text-center text-xs text-slate-500 shadow-lg ring-1 ring-slate-900/10"
                  style={{ width: `${pageWidthMm}mm`, height: `${pageMinHeightMm}mm` }}
                >
                  {previewError ? (
                    <>
                      <span className="font-semibold text-rose-600">A4 preview failed</span>
                      <span className="max-w-full break-words">{previewError}</span>
                    </>
                  ) : (
                    <span>Preparing A4 preview…</span>
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
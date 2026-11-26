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
  Loader2,
} from 'lucide-react';
import { PageTabs } from '../../components/ui/PageTabs';
import { SkBannerHeader } from '../../components/ui/SkBannerHeader';
import { SaveConfirmModal } from '../../components/ui/SaveConfirmModal';
import {
  StatusDialog,
  StatusDialogState,
  INITIAL_STATUS_DIALOG,
} from '../../components/ui/StatusDialog';
import { useSkSystem, formatWholePeso } from '../../hooks/useSkSystem';
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

type BudgetTabKey = 'program-design' | 'registries' | 'summaries';
type PaperSizeKey = 'a4' | 'letter' | 'legal';
type PaperOrientation = 'portrait' | 'landscape';
type BudgetTableName =
  | 'program_design'
  | 'budget_registries'
  | 'budget_summaries';
type RegistryVariantKey = 'mooe' | 'co' | 'spf';
type SummaryVariantKey = 'budget' | 'spf';

interface BudgetLine {
  id: string;
  item: string;
  quantity: string;
  amount: number;
}

interface RegistryEntryRow {
  id: string;
  section: 'budget' | 'commitments' | 'payments';
  particulars: string;
  date: string;
  reference: string;
  amount: number;
  expenseBreakdown: Record<string, number>;
}

interface SummaryProgramRow {
  id: string;
  group: 'current' | 'continuing';
  programCode: string;
  particulars: string;
  allotmentClass: 'MOOE' | 'CO';
  budget: number;
  commitments: number;
  payments: number;
}

interface BudgetPayload {
  activeTab: BudgetTabKey;
  paperSize?: PaperSizeKey;
  orientation?: PaperOrientation;
  sheetNumber: string;
  title: string;
  dateText: string;
  lines: BudgetLine[];
  registryVariant?: RegistryVariantKey;
  programActivity?: string;
  expenseColumns?: string[];
  registryEntries?: RegistryEntryRow[];
  registryCertifiedDate?: string;
  summaryVariant?: SummaryVariantKey;
  asOfDate?: string;
  summaryRows?: SummaryProgramRow[];
  summaryPreparedDate?: string;
  summaryApprovedDate?: string;
}

export interface BudgetDbRecord {
  id: string;
  finalId: string;
  tableName: BudgetTableName;
  docType: BudgetTabKey;
  title: string;
  dateText: string;
  updatedAt: string;
  payload: BudgetPayload;
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

const FIXED_BUDGET_OFFICER = 'HON. ABIJAH MIGUEL C. PACANA';
const FIXED_SK_TREASURER = 'JAN MACKENXIE B. NAVARRO';
const FIXED_SK_CHAIRPERSON = 'HON. RANCE EMIL D. ACHACOSO';
const DEFAULT_EXPENSE_COLUMNS = ['Electricity', 'Water'];
const BUDGET_AUTOSAVE_PREFIX = 'sk_budget_autosave_v2';

const PAPER_DIMENSIONS: Record<
  PaperSizeKey,
  { label: string; widthMm: number; heightMm: number; cssSize: string }
> = {
  a4: { label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297, cssSize: 'A4' },
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
  key: BudgetTabKey;
  label: string;
  description: string;
  tableName: BudgetTableName;
  defaultOrientation: PaperOrientation;
}[] = [
  {
    key: 'program-design',
    label: 'Program Design',
    description:
      'SK Program Design prepared by SK officials and approved by the SK Chairperson.',
    tableName: 'program_design',
    defaultOrientation: 'portrait',
  },
  {
    key: 'registries',
    label: 'Budget Registries',
    description:
      'Registry of Budget / Specific Purpose Fund, Commitments, Payments and Balances.',
    tableName: 'budget_registries',
    defaultOrientation: 'landscape',
  },
  {
    key: 'summaries',
    label: 'Budget Summaries',
    description:
      'Summary of Budget / Specific Purpose Fund, Commitments, Payments and Balances.',
    tableName: 'budget_summaries',
    defaultOrientation: 'landscape',
  },
];

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
      .replace(/^_+|_+$/g, '') || 'Budget_Document'
  );
}

function computeBreakdownSum(
  breakdown: Record<string, number> | undefined,
  cols: string[],
  fallbackAmount = 0
): number {
  if (!breakdown || typeof breakdown !== 'object') {
    return Number(fallbackAmount || 0);
  }
  if (cols.length === 0) {
    const vals = Object.values(breakdown);
    if (vals.length === 0) return Number(fallbackAmount || 0);
    return vals.reduce((sum, v) => sum + Number(v || 0), 0);
  }
  return cols.reduce((sum, colName, idx) => {
    const byIdx = breakdown[String(idx)];
    const byName = breakdown[colName];
    const val = byIdx !== undefined ? byIdx : byName !== undefined ? byName : 0;
    return sum + Number(val || 0);
  }, 0);
}

function getBreakdownCellValue(
  breakdown: Record<string, number> | undefined,
  colName: string,
  colIndex: number
): number {
  if (!breakdown || typeof breakdown !== 'object') return 0;
  if (breakdown[String(colIndex)] !== undefined) {
    return Number(breakdown[String(colIndex)] || 0);
  }
  if (breakdown[colName] !== undefined) {
    return Number(breakdown[colName] || 0);
  }
  return 0;
}

function createEmptyRegistryEntry(
  section: RegistryEntryRow['section'] = 'budget',
  date = ''
): RegistryEntryRow {
  return {
    id: `reg-${crypto.randomUUID()}`,
    section,
    particulars: '',
    date,
    reference: '',
    amount: 0,
    expenseBreakdown: {},
  };
}

function createEmptySummaryRow(
  group: SummaryProgramRow['group'] = 'current'
): SummaryProgramRow {
  return {
    id: `sum-${crypto.randomUUID()}`,
    group,
    programCode: '',
    particulars: '',
    allotmentClass: 'MOOE',
    budget: 0,
    commitments: 0,
    payments: 0,
  };
}

function parseEntryArray(
  val: unknown,
  section: RegistryEntryRow['section'],
  cols: string[]
): RegistryEntryRow[] {
  if (!Array.isArray(val)) return [];
  return val.map((item, idx) => {
    const obj =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const breakdown =
      typeof obj.expenseBreakdown === 'object' && obj.expenseBreakdown !== null
        ? (obj.expenseBreakdown as Record<string, number>)
        : {};
    const computedAmount = computeBreakdownSum(
      breakdown,
      cols,
      Number(obj.amount ?? 0)
    );
    return {
      id: String(obj.id ?? `reg-${section}-${idx}`),
      section,
      particulars: String(obj.particulars ?? ''),
      date: String(obj.date ?? ''),
      reference: String(obj.reference ?? ''),
      amount: computedAmount,
      expenseBreakdown: breakdown,
    };
  });
}

export function BudgetPage() {
  const { committee } = useSkSystem();

  // Multi-user session isolation key for drafts
  const [currentUserId, setCurrentUserId] = useState<string>('anonymous');
  const [isUserResolved, setIsUserResolved] = useState<boolean>(false);
  const restoredForUserRef = useRef<string | null>(null);

  const [activeTab, setActiveTab] = useState<BudgetTabKey>('program-design');
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('a4');
  const [orientation, setOrientation] = useState<PaperOrientation>('portrait');

  const [isSupabaseConnected, setIsSupabaseConnected] = useState<boolean>(false);
  const [isConnectingSupabase, setIsConnectingSupabase] = useState<boolean>(true);

  const [isDatabaseDialogOpen, setIsDatabaseDialogOpen] =
    useState<boolean>(false);
  const [viewingRecord, setViewingRecord] = useState<BudgetDbRecord | null>(
    null
  );
  const [editingRecord, setEditingRecord] = useState<BudgetDbRecord | null>(
    null
  );
  const [editTitleDraft, setEditTitleDraft] = useState<string>('');
  const [editDateDraft, setEditDateDraft] = useState<string>('');
  const [deletingRecord, setDeletingRecord] = useState<BudgetDbRecord | null>(
    null
  );
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const [statusDialog, setStatusDialog] = useState<StatusDialogState>(
    INITIAL_STATUS_DIALOG
  );

  const showStatus = useCallback(
    (
      type: StatusDialogState['type'],
      title: string,
      message: string,
      detail?: string
    ) => {
      setStatusDialog({
        open: true,
        type,
        title,
        message,
        detail,
      });
    },
    []
  );

  const closeStatusDialog = () => {
    setStatusDialog((prev) => ({ ...prev, open: false, hideButtons: false }));
  };

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const { panHandlers, isDragging: isPreviewDragging } = useDragToPan();
  const [previewPages, setPreviewPages] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPageIndex, setPreviewPageIndex] = useState<number>(0);
  const [previewZoom, setPreviewZoom] = useState<number>(100);
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
  const zoomIn = () => setPreviewZoom((prev) => Math.min(prev + 10, 200));
  const zoomOut = () => setPreviewZoom((prev) => Math.max(prev - 10, 50));
  const resetZoom = () => setPreviewZoom(100);

  const activePageIndex =
    previewPages.length > 0
      ? Math.min(Math.max(0, previewPageIndex), previewPages.length - 1)
      : 0;
  const currentPreviewPage = previewPages[activePageIndex] ?? null;

  const [recordUuid, setRecordUuid] = useState<string>(() =>
    crypto.randomUUID()
  );
  // Tracks the loaded record's last known updated_at timestamp for optimistic concurrency
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null);
  const [sheetNumber, setSheetNumber] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [usedDocNumbers, setUsedDocNumbers] = useState<string[]>([]);
  const [dbRecords, setDbRecords] = useState<BudgetDbRecord[]>([]);

  const [confirmSaveOpen, setConfirmSaveOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState<boolean>(false);

  // Program Design state
  const [title, setTitle] = useState('');
  const [dateText, setDateText] = useState('');
  const [lines, setLines] = useState<BudgetLine[]>([
    { id: 'pd-1', item: '', quantity: '', amount: 0 },
  ]);

  // Registry state
  const [registryVariant, setRegistryVariant] =
    useState<RegistryVariantKey>('mooe');
  const [programActivity, setProgramActivity] = useState('');
  const [expenseColumns, setExpenseColumns] = useState<string[]>(() => [
    ...DEFAULT_EXPENSE_COLUMNS,
  ]);
  const [newColumnDraft, setNewColumnDraft] = useState('');
  const [registryEntries, setRegistryEntries] = useState<RegistryEntryRow[]>(
    () => [createEmptyRegistryEntry('budget', '')]
  );
  const [registryCertifiedDate, setRegistryCertifiedDate] = useState('');

  // Summary state
  const [summaryVariant, setSummaryVariant] =
    useState<SummaryVariantKey>('budget');
  const [selectedSpecificRegistryId, setSelectedSpecificRegistryId] =
    useState<string>('');
  const [asOfDate, setAsOfDate] = useState('');
  const [summaryRows, setSummaryRows] = useState<SummaryProgramRow[]>([]);
  const [summaryPreparedDate, setSummaryPreparedDate] = useState('');
  const [summaryApprovedDate, setSummaryApprovedDate] = useState('');

  const preparedBy = committee.requestedBy || FIXED_SK_TREASURER;
  const preparedRole = committee.requestedRole || 'SK Treasurer';
  const budgetOfficerName = FIXED_BUDGET_OFFICER;
  const approvedBy = FIXED_SK_CHAIRPERSON;
  const approvedRole = 'SK Chairperson';

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

  // Resolve authenticated user ID so each user's local draft is strictly isolated
  useEffect(() => {
    let active = true;

    const resolveUser = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!active) return;
        setCurrentUserId(session?.user?.id || 'anonymous');
      } catch {
        if (active) setCurrentUserId('anonymous');
      } finally {
        if (active) setIsUserResolved(true);
      }
    };

    void resolveUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setCurrentUserId(session?.user?.id || 'anonymous');
      setIsUserResolved(true);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const getUserAutosaveKey = useCallback(
    () => `${BUDGET_AUTOSAVE_PREFIX}_${currentUserId}`,
    [currentUserId]
  );

  const buildCurrentDraftSnapshot = useCallback(
    (): BudgetPayload => ({
      activeTab,
      paperSize,
      orientation,
      sheetNumber,
      title,
      dateText,
      lines,
      registryVariant,
      programActivity,
      expenseColumns,
      registryEntries,
      registryCertifiedDate,
      summaryVariant,
      asOfDate,
      summaryRows,
      summaryPreparedDate,
      summaryApprovedDate,
    }),
    [
      activeTab,
      paperSize,
      orientation,
      sheetNumber,
      title,
      dateText,
      lines,
      registryVariant,
      programActivity,
      expenseColumns,
      registryEntries,
      registryCertifiedDate,
      summaryVariant,
      asOfDate,
      summaryRows,
      summaryPreparedDate,
      summaryApprovedDate,
    ]
  );

  // Restore user-specific draft when user identity resolves or changes
  useEffect(() => {
    if (!isUserResolved) return;
    if (restoredForUserRef.current === currentUserId) return;
    restoredForUserRef.current = currentUserId;

    try {
      const raw = window.localStorage.getItem(getUserAutosaveKey());
      if (!raw) {
        // Reset to clean slate if switching to a user with no saved draft
        setRecordUuid(crypto.randomUUID());
        setLoadedUpdatedAt(null);
        setTitle('');
        setDateText('');
        setLines([{ id: `pd-${crypto.randomUUID()}`, item: '', quantity: '', amount: 0 }]);
        setProgramActivity('');
        setExpenseColumns([...DEFAULT_EXPENSE_COLUMNS]);
        setRegistryEntries([createEmptyRegistryEntry('budget', '')]);
        setRegistryCertifiedDate('');
        setAsOfDate('');
        setSummaryRows([]);
        setSummaryPreparedDate('');
        setSummaryApprovedDate('');
        return;
      }

      const parsed = JSON.parse(raw) as {
        id?: string;
        loadedUpdatedAt?: string | null;
        payload?: Partial<BudgetPayload>;
      };

      if (parsed.id) setRecordUuid(parsed.id);
      setLoadedUpdatedAt(parsed.loadedUpdatedAt ?? null);

      const p = parsed.payload;
      if (!p) return;

      if (p.activeTab) setActiveTab(p.activeTab);
      if (p.paperSize) setPaperSize(p.paperSize);
      if (p.orientation) setOrientation(p.orientation);
      if (p.sheetNumber) setSheetNumber(p.sheetNumber);
      if (p.title !== undefined) setTitle(p.title);
      if (p.dateText !== undefined) setDateText(p.dateText);
      if (Array.isArray(p.lines) && p.lines.length > 0) setLines(p.lines);
      if (p.registryVariant) setRegistryVariant(p.registryVariant);
      if (p.programActivity !== undefined) setProgramActivity(p.programActivity);
      if (Array.isArray(p.expenseColumns)) setExpenseColumns(p.expenseColumns);
      if (Array.isArray(p.registryEntries) && p.registryEntries.length > 0) {
        setRegistryEntries(p.registryEntries);
      }
      if (p.registryCertifiedDate !== undefined) {
        setRegistryCertifiedDate(p.registryCertifiedDate);
      }
      if (p.summaryVariant) setSummaryVariant(p.summaryVariant);
      if (p.asOfDate !== undefined) setAsOfDate(p.asOfDate);
      if (Array.isArray(p.summaryRows)) setSummaryRows(p.summaryRows);
      if (p.summaryPreparedDate !== undefined) {
        setSummaryPreparedDate(p.summaryPreparedDate);
      }
      if (p.summaryApprovedDate !== undefined) {
        setSummaryApprovedDate(p.summaryApprovedDate);
      }
    } catch {
      // Ignore storage errors
    }
  }, [currentUserId, getUserAutosaveKey, isUserResolved]);

  // Persist current user's draft isolated by user ID
  useEffect(() => {
    if (!isUserResolved || restoredForUserRef.current !== currentUserId) return;
    try {
      window.localStorage.setItem(
        getUserAutosaveKey(),
        JSON.stringify({
          id: recordUuid,
          loadedUpdatedAt,
          savedAt: new Date().toISOString(),
          payload: buildCurrentDraftSnapshot(),
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }, [
    buildCurrentDraftSnapshot,
    currentUserId,
    getUserAutosaveKey,
    isUserResolved,
    loadedUpdatedAt,
    recordUuid,
  ]);

  const handleTabChange = (nextTab: BudgetTabKey) => {
    setActiveTab(nextTab);
    const meta = TABS.find((t) => t.key === nextTab);
    if (meta) {
      setOrientation(meta.defaultOrientation);
    }
  };

  const hydrateNumbersFromDbRows = useCallback((rows: BudgetDbRecord[]) => {
    const nos = rows
      .map((r) => r.finalId || r.payload?.sheetNumber)
      .filter((v): v is string => Boolean(v));
    setUsedDocNumbers((prev) => Array.from(new Set([...prev, ...nos])));
    setSheetNumber((curr) =>
      nos.includes(curr) ? generateUniqueDocNumber(nos) : curr
    );
  }, []);

  const loadBudgetRecordsFromSupabase = useCallback(async () => {
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);

    const collected: BudgetDbRecord[] = [];

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

        const sheetId = String(row.sheet_number ?? generateUniqueDocNumber([]));

        const rowTitle = String(
          row.title ?? row.program_project_activity ?? `Untitled ${tab.label}`
        );

        const rowDate = String(
          row.start_date ?? row.prepared_date ?? row.as_of_date ?? ''
        );

        const rowLines = Array.isArray(row.items)
          ? (row.items as BudgetLine[])
          : [];

        const cols: string[] = Array.isArray(row.expense_columns)
          ? (row.expense_columns as string[])
          : [...DEFAULT_EXPENSE_COLUMNS];

        let hydratedEntries: RegistryEntryRow[] = [
          ...parseEntryArray(row.budget_entries, 'budget', cols),
          ...parseEntryArray(row.commitment_entries, 'commitments', cols),
          ...parseEntryArray(row.payment_entries, 'payments', cols),
        ];

        const dbTotalBudget = Number(row.total_budget ?? 0);
        if (hydratedEntries.length === 0 && dbTotalBudget > 0) {
          hydratedEntries = [
            {
              id: `reg-db-${id}`,
              section: 'budget',
              particulars: String(row.program_project_activity ?? 'Budget'),
              date: String(row.prepared_date ?? ''),
              reference: '',
              amount: dbTotalBudget,
              expenseBreakdown: {},
            },
          ];
        }

        const allotmentUpper = String(row.allotment_class || '').toUpperCase();
        const resolvedRegistryVariant: RegistryVariantKey =
          allotmentUpper === 'CO'
            ? 'co'
            : allotmentUpper === 'SPF'
            ? 'spf'
            : 'mooe';

        const resolvedSummaryVariant: SummaryVariantKey = String(
          row.summary_type || ''
        )
          .toUpperCase()
          .includes('SPF')
          ? 'spf'
          : 'budget';

        const resolvedSummaryRows: SummaryProgramRow[] =
          tab.key === 'summaries' && Array.isArray(row.items)
            ? (row.items as SummaryProgramRow[])
            : [];

        const payload: BudgetPayload = {
          activeTab: tab.key,
          paperSize: 'a4',
          orientation: tab.defaultOrientation,
          sheetNumber: sheetId,
          title: rowTitle,
          dateText: rowDate,
          lines: rowLines,
          registryVariant: resolvedRegistryVariant,
          programActivity: String(row.program_project_activity ?? ''),
          expenseColumns: cols,
          registryEntries: hydratedEntries,
          registryCertifiedDate: String(row.prepared_date ?? rowDate),
          summaryVariant: resolvedSummaryVariant,
          asOfDate: String(row.as_of_date ?? rowDate),
          summaryRows: resolvedSummaryRows,
          summaryPreparedDate: String(row.prepared_date ?? rowDate),
          summaryApprovedDate: String(row.approved_date ?? rowDate),
        };

        collected.push({
          id,
          finalId: sheetId,
          tableName: tab.tableName,
          docType: tab.key,
          title: rowTitle,
          dateText: rowDate,
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
  }, [hydrateNumbersFromDbRows]);

  // Initial load + Realtime multi-user synchronization
  useEffect(() => {
    let active = true;

    const initConnectionAndLoad = async () => {
      const connected = await checkSupabaseConnected();
      if (!active) return;

      if (!connected) {
        setIsSupabaseConnected(false);
        setIsConnectingSupabase(true);
        await ensureSupabaseConnected((connecting) => {
          if (active) setIsConnectingSupabase(connecting);
        });
        if (!active) return;
      }

      setIsSupabaseConnected(true);
      setIsConnectingSupabase(false);
      await loadBudgetRecordsFromSupabase();
    };

    void initConnectionAndLoad();

    const channel = supabase
      .channel('budget-realtime-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'program_design' },
        () => {
          if (active) void loadBudgetRecordsFromSupabase();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'budget_registries' },
        () => {
          if (active) void loadBudgetRecordsFromSupabase();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'budget_summaries' },
        () => {
          if (active) void loadBudgetRecordsFromSupabase();
        }
      )
      .subscribe();

    const intervalId = window.setInterval(async () => {
      const connected = await checkSupabaseConnected();
      if (!active) return;
      setIsSupabaseConnected(connected);
      setIsConnectingSupabase(!connected);
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      void supabase.removeChannel(channel);
    };
  }, [loadBudgetRecordsFromSupabase]);

  const registryRecords = dbRecords.filter((r) => r.docType === 'registries');

  const computeAutoBudgetSummaryRows = useCallback((): SummaryProgramRow[] => {
    const otherRegistryRecords = registryRecords.filter(
      (rec) => rec.id !== recordUuid
    );

    const sources: {
      variant: RegistryVariantKey;
      activity: string;
      entries: RegistryEntryRow[];
      cols: string[];
    }[] = otherRegistryRecords.map((rec) => {
      const cols = Array.isArray(rec.payload.expenseColumns)
        ? rec.payload.expenseColumns
        : DEFAULT_EXPENSE_COLUMNS;
      const entries = (
        Array.isArray(rec.payload.registryEntries)
          ? rec.payload.registryEntries
          : []
      ).map((e) => ({
        ...e,
        amount: computeBreakdownSum(e.expenseBreakdown, cols, e.amount),
      }));
      return {
        variant: rec.payload.registryVariant || 'mooe',
        activity:
          rec.payload.programActivity?.trim() ||
          rec.title.trim() ||
          'Program / Project / Activity',
        entries,
        cols,
      };
    });

    const normalizedCurrentEntries = registryEntries.map((e) => ({
      ...e,
      amount: computeBreakdownSum(e.expenseBreakdown, expenseColumns, e.amount),
    }));

    const hasCurrentEntries = normalizedCurrentEntries.some(
      (e) =>
        e.particulars.trim() ||
        e.reference.trim() ||
        Number(e.amount || 0) !== 0
    );

    if (hasCurrentEntries || sources.length === 0) {
      sources.push({
        variant: registryVariant,
        activity: programActivity.trim() || 'Program / Project / Activity',
        entries: normalizedCurrentEntries,
        cols: expenseColumns,
      });
    }

    const grouped = new Map<string, SummaryProgramRow>();

    for (const src of sources) {
      const allotmentClass: 'MOOE' | 'CO' =
        src.variant === 'co' || src.variant === 'spf' ? 'CO' : 'MOOE';
      const group: SummaryProgramRow['group'] = 'current';
      const key = `${group}::${allotmentClass}::${src.activity}`;

      const budgetAmt = src.entries
        .filter((e) => e.section === 'budget')
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const commitmentsAmt = src.entries
        .filter((e) => e.section === 'commitments')
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const paymentsAmt = src.entries
        .filter((e) => e.section === 'payments')
        .reduce((s, e) => s + Number(e.amount || 0), 0);

      const existing = grouped.get(key);
      if (existing) {
        existing.budget += budgetAmt;
        existing.commitments += commitmentsAmt;
        existing.payments += paymentsAmt;
      } else {
        grouped.set(key, {
          id: `auto-sum-${allotmentClass}-${encodeURIComponent(src.activity)}`,
          group,
          programCode: '',
          particulars: src.activity,
          allotmentClass,
          budget: budgetAmt,
          commitments: commitmentsAmt,
          payments: paymentsAmt,
        });
      }
    }

    return Array.from(grouped.values());
  }, [
    registryRecords,
    recordUuid,
    registryEntries,
    expenseColumns,
    registryVariant,
    programActivity,
  ]);

  useEffect(() => {
    if (activeTab === 'summaries' && summaryVariant === 'budget') {
      setSummaryRows(computeAutoBudgetSummaryRows());
    }
  }, [activeTab, summaryVariant, computeAutoBudgetSummaryRows]);

  const handlePickSpecificRegistry = (recId: string) => {
    setSelectedSpecificRegistryId(recId);
    if (!recId) return;

    if (recId === '__current__') {
      const normalized = registryEntries.map((e) => ({
        ...e,
        amount: computeBreakdownSum(e.expenseBreakdown, expenseColumns, e.amount),
      }));
      const budgetAmt = normalized
        .filter((e) => e.section === 'budget')
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const commitmentsAmt = normalized
        .filter((e) => e.section === 'commitments')
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      const paymentsAmt = normalized
        .filter((e) => e.section === 'payments')
        .reduce((s, e) => s + Number(e.amount || 0), 0);

      const pickedRow: SummaryProgramRow = {
        id: `spf-sum-${crypto.randomUUID()}`,
        group: 'current',
        programCode: '',
        particulars: programActivity.trim() || 'Current Registry',
        allotmentClass: registryVariant === 'mooe' ? 'MOOE' : 'CO',
        budget: budgetAmt,
        commitments: commitmentsAmt,
        payments: paymentsAmt,
      };
      setSummaryRows((prev) => [...prev, pickedRow]);
      return;
    }

    const found = registryRecords.find((r) => r.id === recId);
    if (!found) return;

    const cols = Array.isArray(found.payload.expenseColumns)
      ? found.payload.expenseColumns
      : DEFAULT_EXPENSE_COLUMNS;
    const entries = (
      Array.isArray(found.payload.registryEntries)
        ? found.payload.registryEntries
        : []
    ).map((e) => ({
      ...e,
      amount: computeBreakdownSum(e.expenseBreakdown, cols, e.amount),
    }));
    const budgetAmt = entries
      .filter((e) => e.section === 'budget')
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const commitmentsAmt = entries
      .filter((e) => e.section === 'commitments')
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const paymentsAmt = entries
      .filter((e) => e.section === 'payments')
      .reduce((s, e) => s + Number(e.amount || 0), 0);

    const pickedRow: SummaryProgramRow = {
      id: `spf-sum-${crypto.randomUUID()}`,
      group: 'current',
      programCode: '',
      particulars:
        found.payload.programActivity?.trim() ||
        found.title.trim() ||
        found.finalId,
      allotmentClass:
        found.payload.registryVariant === 'mooe' ? 'MOOE' : 'CO',
      budget: budgetAmt,
      commitments: commitmentsAmt,
      payments: paymentsAmt,
    };

    setSummaryRows((prev) => [...prev, pickedRow]);
  };

  const parseQtyCount = (qtyStr: string) => {
    const match = qtyStr.match(/[\d,.]+/);
    return match ? Number(match[0].replace(/,/g, '')) || 1 : 1;
  };

  const grandTotal = lines.reduce(
    (sum, l) => sum + parseQtyCount(l.quantity) * (l.amount || 0),
    0
  );

  const computedRegistryEntries: RegistryEntryRow[] = registryEntries.map(
    (entry) => ({
      ...entry,
      amount: computeBreakdownSum(
        entry.expenseBreakdown,
        expenseColumns,
        entry.amount
      ),
    })
  );

  const regBudgetTotal = computedRegistryEntries
    .filter((e) => e.section === 'budget')
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const regCommitmentsTotal = computedRegistryEntries
    .filter((e) => e.section === 'commitments')
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const regPaymentsTotal = computedRegistryEntries
    .filter((e) => e.section === 'payments')
    .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const regAvailableBalance = regBudgetTotal - regCommitmentsTotal;

  const currentSummaryRows = summaryRows.filter((r) => r.group === 'current');
  const continuingSummaryRows = summaryRows.filter(
    (r) => r.group === 'continuing'
  );

  const currentSubBudget = currentSummaryRows.reduce(
    (s, r) => s + Number(r.budget || 0),
    0
  );
  const currentSubCommitments = currentSummaryRows.reduce(
    (s, r) => s + Number(r.commitments || 0),
    0
  );
  const currentSubPayments = currentSummaryRows.reduce(
    (s, r) => s + Number(r.payments || 0),
    0
  );

  const continuingSubBudget = continuingSummaryRows.reduce(
    (s, r) => s + Number(r.budget || 0),
    0
  );
  const continuingSubCommitments = continuingSummaryRows.reduce(
    (s, r) => s + Number(r.commitments || 0),
    0
  );
  const continuingSubPayments = continuingSummaryRows.reduce(
    (s, r) => s + Number(r.payments || 0),
    0
  );

  const sumGrandBudget = currentSubBudget + continuingSubBudget;
  const sumGrandCommitments = currentSubCommitments + continuingSubCommitments;
  const sumGrandPayments = currentSubPayments + continuingSubPayments;

  const currentTabMeta = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  const getCurrentRecordTitle = (): string => {
    if (activeTab === 'program-design')
      return title.trim() || 'Program Design';
    if (activeTab === 'registries')
      return programActivity.trim() || `Registry ${sheetNumber}`;
    return `Summary (${asOfDate || sheetNumber})`;
  };

  const getCurrentRecordDate = (): string => {
    if (activeTab === 'program-design') return dateText;
    if (activeTab === 'registries') return registryCertifiedDate || dateText;
    return asOfDate || dateText;
  };

  const requestSaveConfirmation = async () => {
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);
    if (!confirmSaveOpen && !isSaving) {
      setConfirmSaveOpen(true);
    }
  };

  useEnterToSave({
    enabled:
      isSupabaseConnected &&
      !isConnectingSupabase &&
      !confirmSaveOpen &&
      !floatingInput.visible &&
      !isDatabaseDialogOpen &&
      !viewingRecord &&
      !editingRecord &&
      !deletingRecord &&
      !statusDialog.open,
    onTriggerSave: () => {
      void requestSaveConfirmation();
    },
  });

  const handleGenerateNewSheetNumber = () => {
    const dbNos = dbRecords.map((r) => r.finalId || r.payload?.sheetNumber);
    const next = generateUniqueDocNumber([
      ...usedDocNumbers,
      ...dbNos,
      sheetNumber,
    ]);
    setUsedDocNumbers((prev) => Array.from(new Set([...prev, sheetNumber, next])));
    setRecordUuid(crypto.randomUUID());
    setLoadedUpdatedAt(null);
    setSheetNumber(next);
  };

  const handleRegistryVariantChange = (nextVariant: RegistryVariantKey) => {
    setRegistryVariant(nextVariant);
    setExpenseColumns([...DEFAULT_EXPENSE_COLUMNS]);
    setRegistryEntries([createEmptyRegistryEntry('budget', dateText)]);
  };

  const renameExpenseColumn = (index: number, nextName: string) => {
    setExpenseColumns((prev) =>
      prev.map((col, idx) => (idx === index ? nextName : col))
    );
  };

  const addExpenseColumn = () => {
    const trimmed = newColumnDraft.trim();
    const label = trimmed || `Expenditure Item ${expenseColumns.length + 1}`;
    setExpenseColumns((prev) => [...prev, label]);
    setNewColumnDraft('');
  };

  const removeExpenseColumn = (index: number) => {
    const removedName = expenseColumns[index];
    setExpenseColumns((prev) => prev.filter((_, idx) => idx !== index));
    setRegistryEntries((prev) =>
      prev.map((entry) => {
        if (!entry.expenseBreakdown) return entry;
        const copy = { ...entry.expenseBreakdown };
        delete copy[String(index)];
        if (removedName) delete copy[removedName];
        const nextAmount = Object.values(copy).reduce(
          (sum, v) => sum + Number(v || 0),
          0
        );
        return {
          ...entry,
          expenseBreakdown: copy,
          amount: nextAmount,
        };
      })
    );
  };

  const paperSpec = PAPER_DIMENSIONS[paperSize];
  const pageWidthMm =
    orientation === 'portrait' ? paperSpec.widthMm : paperSpec.heightMm;
  const pageMinHeightMm =
    orientation === 'portrait' ? paperSpec.heightMm : paperSpec.widthMm;


  // Render the full document off-screen, then show it as fixed-size paper pages.
  // This prevents long records from stretching one preview sheet vertically.
  useEffect(() => {
    // The page returns a database-connection screen before the paper is mounted.
    // Do not start preview capture until the connected state renders the paper.
    if (isConnectingSupabase || !isSupabaseConnected) return;

    const source = sheetRef.current;
    if (!source) return;

    setPreviewError(null);

    let timer: ReturnType<typeof window.setTimeout> | undefined;
    let renderId = 0;
    let disposed = false;

    const renderPreview = () => {
      // Coalesce bursts of DOM mutations without repeatedly cancelling the
      // first render. A continuously changing hidden form must not keep the
      // preview in "Preparing preview…" forever.
      if (timer) return;

      timer = window.setTimeout(async () => {
        timer = undefined;
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
          captureHost.style.width = `${pageWidthMm}mm`;
          captureHost.style.maxWidth = `${pageWidthMm}mm`;
          captureHost.style.minHeight = `${pageMinHeightMm}mm`;
          captureHost.style.boxSizing = 'border-box';
          captureHost.style.overflow = 'visible';

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
          captureClone.style.boxSizing = 'border-box';
          captureClone.style.width = `${pageWidthMm}mm`;
          captureClone.style.minWidth = `${pageWidthMm}mm`;
          captureClone.style.maxWidth = `${pageWidthMm}mm`;
          captureClone.style.minHeight = `${pageMinHeightMm}mm`;
          captureClone.style.height = 'auto';
          captureClone.style.overflow = 'visible';

          // Make captured tables and cells fit the paper width.
          captureClone.querySelectorAll<HTMLElement>('*').forEach((node) => {
            node.style.boxSizing = 'border-box';
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

          captureClone.querySelectorAll<HTMLElement>('p, span, div, li, td, th').forEach((element) => {
            element.style.maxWidth = '100%';
            element.style.overflowWrap = 'anywhere';
            element.style.wordBreak = 'break-word';
          });
          captureHost.appendChild(captureClone);
          document.body.appendChild(captureHost);

          let canvas: HTMLCanvasElement;
          try {
            // Wait for fonts, embedded logos, and React layout before capturing.
            await (document.fonts?.ready ?? Promise.resolve());
            await Promise.all(
              Array.from(captureClone.querySelectorAll('img')).map((image) =>
                typeof image.decode === 'function'
                  ? image.decode().catch(() => undefined)
                  : Promise.resolve()
              )
            );
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() =>
                window.requestAnimationFrame(() => resolve())
              );
            });

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

          if (disposed || thisRender !== renderId) return;
          if (!canvas.width || !canvas.height) {
            throw new Error('The Budget paper preview has no measurable size.');
          }
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

    // Match the Procurement preview: observe the hidden paper and refresh
    // whenever React updates its rendered content.
    const observer = new MutationObserver(renderPreview);
    observer.observe(source, {
      childList: true,
      subtree: true,
      characterData: true,
      // Attribute mutations can be noisy (style updates) and may continually
      // postpone capture. Content changes are covered by child/text changes.
      attributes: false,
    });

    const resizeObserver = new ResizeObserver(renderPreview);
    resizeObserver.observe(source);

    source.addEventListener('input', renderPreview, true);
    source.addEventListener('change', renderPreview, true);

    // Explicit first capture, independent of whether the observer sees a
    // mutation. A short delay gives React the chance to commit the paper.
    timer = window.setTimeout(() => {
      timer = undefined;
      renderPreview();
    }, 80);

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      observer.disconnect();
      resizeObserver.disconnect();
      source.removeEventListener('input', renderPreview, true);
      source.removeEventListener('change', renderPreview, true);
    };
  }, [
    pageWidthMm,
    pageMinHeightMm,
    activeTab,
    orientation,
    buildCurrentDraftSnapshot,
    isConnectingSupabase,
    isSupabaseConnected,
  ]);

  const handleDownloadPdf = async () => {
    const sheet = sheetRef.current;
    if (!sheet || isDownloadingPdf) return;

    closeStatusDialog();
    const code = sanitizeFileSegment(
      activeTab === 'program-design'
        ? getCurrentRecordTitle()
        : sheetNumber || getCurrentRecordTitle() || activeTab
    );
    const fileName = `${activeTab.toUpperCase()}_${code}.pdf`;

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

  const buildSupabaseRowForTab = (
    resolvedFinalId: string
  ): Record<string, unknown> => {
    const currentDate = getCurrentRecordDate();
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(currentDate)
      ? currentDate
      : null;

    if (activeTab === 'program-design') {
      return {
        id: recordUuid,
        sheet_number: resolvedFinalId,
        title: title.trim() || 'Untitled Program Design',
        start_date: validDate,
        end_date: validDate,
        total_amount: grandTotal,
        items: lines,
        prepared_by: { name: preparedBy, role: preparedRole },
        approved_by: { name: approvedBy, role: approvedRole },
        prepared_date: validDate,
        approved_date: validDate,
      };
    }

    if (activeTab === 'registries') {
      const allotmentClass =
        registryVariant === 'co'
          ? 'CO'
          : registryVariant === 'spf'
          ? 'SPF'
          : 'MOOE';

      const budgetEntriesList = computedRegistryEntries.filter(
        (e) => e.section === 'budget'
      );
      const commitmentEntriesList = computedRegistryEntries.filter(
        (e) => e.section === 'commitments'
      );
      const paymentEntriesList = computedRegistryEntries.filter(
        (e) => e.section === 'payments'
      );

      return {
        id: recordUuid,
        registry_type:
          registryVariant === 'spf' ? 'SK_SPF_REGISTRY' : 'SK_REGISTRY',
        allotment_class: allotmentClass,
        sheet_number: resolvedFinalId,
        barangay: 'Kauswagan',
        city: 'Cagayan de Oro City',
        province: 'Misamis Oriental',
        budget_monitoring_officer: budgetOfficerName,
        program_project_activity: programActivity.trim(),
        expense_columns: expenseColumns,
        budget_entries: budgetEntriesList,
        commitment_entries: commitmentEntriesList,
        payment_entries: paymentEntriesList,
        total_budget: regBudgetTotal,
        total_commitments: regCommitmentsTotal,
        total_payments: regPaymentsTotal,
        balance_available_budget: regAvailableBalance,
        balance_unpaid_commitment: regCommitmentsTotal - regPaymentsTotal,
        prepared_by_name: budgetOfficerName,
        prepared_date: /^\d{4}-\d{2}-\d{2}$/.test(registryCertifiedDate)
          ? registryCertifiedDate
          : validDate,
      };
    }

    return {
      id: recordUuid,
      summary_type:
        summaryVariant === 'spf' ? 'SPF_SUMMARY' : 'BUDGET_SUMMARY',
      sheet_number: resolvedFinalId,
      as_of_date: /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ? asOfDate : null,
      barangay: 'Kauswagan',
      city: 'Cagayan de Oro City',
      province: 'Misamis Oriental',
      items: summaryRows,
      grand_total_budget: sumGrandBudget,
      grand_total_available_budget: sumGrandBudget - sumGrandCommitments,
      prepared_by_name: budgetOfficerName,
      prepared_date: /^\d{4}-\d{2}-\d{2}$/.test(summaryPreparedDate)
        ? summaryPreparedDate
        : validDate,
      approved_by_name: approvedBy,
      approved_date: /^\d{4}-\d{2}-\d{2}$/.test(summaryApprovedDate)
        ? summaryApprovedDate
        : validDate,
    };
  };

  const handleSaveToSupabase = async (): Promise<BudgetDbRecord[]> => {
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);

    // Concurrency check: fetch current DB state for this table before writing
    const { data: existingRows, error: fetchError } = await supabase
      .from(currentTabMeta.tableName as never)
      .select('id, sheet_number, updated_at');

    if (fetchError) {
      throw new Error(fetchError.message);
    }

    const existingList = (existingRows ?? []) as {
      id: string;
      sheet_number?: string;
      updated_at?: string;
    }[];

    const existingSameRecord = existingList.find((r) => r.id === recordUuid);

    // Optimistic lock check if editing an existing record
    if (
      existingSameRecord &&
      loadedUpdatedAt &&
      existingSameRecord.updated_at &&
      existingSameRecord.updated_at !== loadedUpdatedAt
    ) {
      throw new Error(
        'Concurrent edit conflict: Another user updated this record while you were editing it. Reload the latest version from the Database dialog before saving.'
      );
    }

    // Ensure unique sheet_number across concurrent inserts
    const dbSheetNumbers = existingList
      .filter((r) => r.id !== recordUuid)
      .map((r) => r.sheet_number)
      .filter((v): v is string => Boolean(v));

    let resolvedFinalId =
      sheetNumber.trim() || generateUniqueDocNumber(dbSheetNumbers);

    if (!existingSameRecord && dbSheetNumbers.includes(resolvedFinalId)) {
      resolvedFinalId = generateUniqueDocNumber([
        ...dbSheetNumbers,
        ...usedDocNumbers,
      ]);
    }
    setSheetNumber(resolvedFinalId);

    const supabaseRow = buildSupabaseRowForTab(resolvedFinalId);

    const { error } = await supabase
      .from(currentTabMeta.tableName as never)
      .upsert(supabaseRow as never, { onConflict: 'id' });

    if (error) {
      throw new Error(error.message);
    }

    const latest = await loadBudgetRecordsFromSupabase();
    showStatus(
      'success',
      'Saved to Supabase',
      activeTab === 'program-design'
        ? `Saved "${getCurrentRecordTitle()}" to ${currentTabMeta.tableName}.`
        : `Saved (${resolvedFinalId}) to ${currentTabMeta.tableName}.`
    );
    return latest;
  };

  const advanceAfterSave = (latestRecords: BudgetDbRecord[]) => {
    const dbNos = latestRecords.map((r) => r.finalId || r.payload?.sheetNumber);
    const nextNo = generateUniqueDocNumber([
      ...usedDocNumbers,
      ...dbNos,
      sheetNumber,
    ]);
    setUsedDocNumbers((prev) =>
      Array.from(new Set([...prev, ...dbNos, sheetNumber, nextNo]))
    );
    setRecordUuid(crypto.randomUUID());
    setLoadedUpdatedAt(null);
    setSheetNumber(nextNo);
  };

  const handleConfirmSave = async () => {
    setIsSaving(true);
    try {
      const latest = await handleSaveToSupabase();
      advanceAfterSave(latest);
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

  const handleNewDraft = () => {
    handleGenerateNewSheetNumber();
    if (activeTab === 'program-design') {
      setTitle('');
      setDateText('');
      setLines([
        { id: `pd-${crypto.randomUUID()}`, item: '', quantity: '', amount: 0 },
      ]);
    } else if (activeTab === 'registries') {
      setProgramActivity('');
      setExpenseColumns([...DEFAULT_EXPENSE_COLUMNS]);
      setRegistryEntries([createEmptyRegistryEntry('budget', '')]);
      setRegistryCertifiedDate('');
    } else {
      setSelectedSpecificRegistryId('');
      setAsOfDate('');
      setSummaryRows([]);
      setSummaryPreparedDate('');
      setSummaryApprovedDate('');
    }
  };

  const openEditDialog = async (rec: BudgetDbRecord) => {
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);
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
    const nextTab = p.activeTab || rec.docType;
    const tabDefaultOrientation =
      TABS.find((t) => t.key === nextTab)?.defaultOrientation || 'portrait';

    setRecordUuid(rec.id);
    setLoadedUpdatedAt(rec.updatedAt || null);
    setSheetNumber(p.sheetNumber || rec.finalId);
    setActiveTab(nextTab);
    if (p.paperSize) setPaperSize(p.paperSize);
    setOrientation(p.orientation || tabDefaultOrientation);

    setTitle(nextTab === 'program-design' ? nextTitle : p.title || '');
    setDateText(nextDate);
    setLines(
      Array.isArray(p.lines) && p.lines.length > 0
        ? p.lines
        : [{ id: `pd-${crypto.randomUUID()}`, item: '', quantity: '', amount: 0 }]
    );

    if (p.registryVariant) {
      setRegistryVariant(p.registryVariant);
    }
    setProgramActivity(
      nextTab === 'registries' ? nextTitle : p.programActivity || ''
    );
    const loadedCols = Array.isArray(p.expenseColumns)
      ? p.expenseColumns
      : [...DEFAULT_EXPENSE_COLUMNS];
    setExpenseColumns(loadedCols);
    setRegistryEntries(
      Array.isArray(p.registryEntries) && p.registryEntries.length > 0
        ? p.registryEntries.map((e) => ({
            ...e,
            amount: computeBreakdownSum(e.expenseBreakdown, loadedCols, e.amount),
          }))
        : [createEmptyRegistryEntry('budget', '')]
    );
    setRegistryCertifiedDate(p.registryCertifiedDate || '');

    if (p.summaryVariant) {
      setSummaryVariant(p.summaryVariant);
    }
    setAsOfDate(p.asOfDate || nextDate || '');
    setSummaryRows(Array.isArray(p.summaryRows) ? p.summaryRows : []);
    setSummaryPreparedDate(p.summaryPreparedDate || '');
    setSummaryApprovedDate(p.summaryApprovedDate || '');

    setEditingRecord(null);
    setIsDatabaseDialogOpen(false);
    showStatus(
      'info',
      'Record Loaded',
      `Loaded ${
        nextTab === 'program-design'
          ? nextTitle
          : p.sheetNumber || rec.finalId || 'record'
      } into the editor.`
    );
  };

  const handleConfirmDeleteRecord = async () => {
    if (!deletingRecord) return;
    setIsDeleting(true);
    try {
      await ensureSupabaseConnected(setIsConnectingSupabase);
      setIsSupabaseConnected(true);

      const rec = deletingRecord;
      const { error } = await supabase
        .from(rec.tableName as never)
        .delete()
        .eq('id' as never, rec.id as never);

      if (error) {
        throw new Error(error.message);
      }

      await loadBudgetRecordsFromSupabase();
      if (viewingRecord?.id === rec.id) {
        setViewingRecord(null);
      }
      setDeletingRecord(null);
      showStatus(
        'success',
        'Record Deleted',
        `Deleted ${rec.title || rec.finalId || 'record'} from ${rec.tableName}.`
      );
    } catch (err) {
      setDeletingRecord(null);
      showStatus(
        'error',
        'Delete Failed',
        'Could not delete the record from Supabase.',
        err instanceof Error ? err.message : 'Please try again.'
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const openFloatingInput = (
    el: HTMLInputElement,
    type: 'text' | 'number',
    value: string | number,
    onCommit: (nextVal: string) => void,
    align: 'left' | 'right' = 'left'
  ) => {
    const rect = el.getBoundingClientRect();
    const expandedWidth = Math.max(rect.width + 72, 160);
    const maxLeft = Math.max(8, window.innerWidth - expandedWidth - 12);
    const clampedLeft = Math.min(Math.max(8, rect.left - 16), maxLeft);

    setFloatingInput({
      visible: true,
      top: rect.top - 4,
      left: clampedLeft,
      width: expandedWidth,
      height: Math.max(rect.height + 8, 32),
      type,
      value,
      align,
      onCommit,
    });

    requestAnimationFrame(() => {
      floatingRef.current?.focus();
    });
  };

  const closeFloatingInput = () => {
    setFloatingInput((prev) => ({ ...prev, visible: false }));
  };

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      { id: `pd-${crypto.randomUUID()}`, item: '', quantity: '', amount: 0 },
    ]);

  const updateLine = <K extends keyof BudgetLine>(
    id: string,
    key: K,
    val: BudgetLine[K]
  ) =>
    setLines((prev) =>
      prev.map((l) => (l.id === id ? { ...l, [key]: val } : l))
    );

  const removeLine = (id: string) =>
    setLines((prev) =>
      prev.length > 1 ? prev.filter((l) => l.id !== id) : prev
    );

  const addRegistryEntry = () =>
    setRegistryEntries((prev) => [
      ...prev,
      createEmptyRegistryEntry('commitments', dateText),
    ]);

  const updateRegistryEntry = <K extends keyof RegistryEntryRow>(
    id: string,
    key: K,
    val: RegistryEntryRow[K]
  ) =>
    setRegistryEntries((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [key]: val } : row))
    );

  const updateRegistryBreakdown = (
    entryId: string,
    colIndex: number,
    colName: string,
    rawVal: string
  ) => {
    const numVal = Number(rawVal) || 0;
    setRegistryEntries((prev) =>
      prev.map((row) => {
        if (row.id !== entryId) return row;
        const nextBreakdown: Record<string, number> = {
          ...(row.expenseBreakdown || {}),
          [String(colIndex)]: numVal,
        };
        if (colName) {
          nextBreakdown[colName] = numVal;
        }
        const nextTotal = computeBreakdownSum(nextBreakdown, expenseColumns, 0);
        return {
          ...row,
          expenseBreakdown: nextBreakdown,
          amount: nextTotal,
        };
      })
    );
  };

  const sumSectionByColumn = (
    rows: RegistryEntryRow[],
    colName: string,
    colIndex: number
  ) =>
    rows.reduce(
      (sum, r) =>
        sum + getBreakdownCellValue(r.expenseBreakdown, colName, colIndex),
      0
    );

  const removeRegistryEntry = (id: string) =>
    setRegistryEntries((prev) =>
      prev.length > 1 ? prev.filter((row) => row.id !== id) : prev
    );

  const addSummaryRow = () =>
    setSummaryRows((prev) => [...prev, createEmptySummaryRow('current')]);

  const updateSummaryRow = <K extends keyof SummaryProgramRow>(
    id: string,
    key: K,
    val: SummaryProgramRow[K]
  ) =>
    setSummaryRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [key]: val } : row))
    );

  const removeSummaryRow = (id: string) =>
    setSummaryRows((prev) => prev.filter((row) => row.id !== id));

  const renderFormInputs = () => {
    if (activeTab === 'program-design') {
      return (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Program / Activity Title
            </label>
            <input
              type="text"
              placeholder="Enter program or activity title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) =>
                openFloatingInput(e.currentTarget, 'text', title, (next) =>
                  setTitle(next)
                )
              }
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
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
              value={dateText}
              onChange={(e) => setDateText(formatAutoDashDate(e.target.value))}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                Line Item Budget ({lines.length})
              </span>
              <button
                type="button"
                onClick={addLine}
                className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Line</span>
              </button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-700 border-b border-slate-200">
                  <tr>
                    <th className="px-2.5 py-2 text-left font-semibold">
                      Item
                    </th>
                    <th className="px-2.5 py-2 text-left font-semibold w-24">
                      Qty
                    </th>
                    <th className="px-2.5 py-2 text-right font-semibold w-24">
                      Amount
                    </th>
                    <th className="px-2.5 py-2 w-8" aria-label="Remove row" />
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-200">
                  {lines.map((line) => (
                    <tr
                      key={line.id}
                      className="bg-white hover:bg-slate-50/70"
                    >
                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          value={line.item}
                          placeholder="Item"
                          onChange={(e) =>
                            updateLine(line.id, 'item', e.target.value)
                          }
                          onFocus={(e) =>
                            openFloatingInput(
                              e.currentTarget,
                              'text',
                              line.item,
                              (next) => updateLine(line.id, 'item', next)
                            )
                          }
                          className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                        />
                      </td>
                      <td className="px-1.5 py-1.5">
                        <input
                          type="text"
                          value={line.quantity}
                          placeholder="Qty"
                          onChange={(e) =>
                            updateLine(line.id, 'quantity', e.target.value)
                          }
                          onFocus={(e) =>
                            openFloatingInput(
                              e.currentTarget,
                              'text',
                              line.quantity,
                              (next) => updateLine(line.id, 'quantity', next)
                            )
                          }
                          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                        />
                      </td>
                      <td className="px-1.5 py-1.5">
                        <input
                          type="number"
                          value={line.amount === 0 ? '' : line.amount}
                          placeholder="0"
                          onChange={(e) =>
                            updateLine(line.id, 'amount', Number(e.target.value))
                          }
                          onFocus={(e) =>
                            openFloatingInput(
                              e.currentTarget,
                              'number',
                              line.amount,
                              (next) =>
                                updateLine(line.id, 'amount', Number(next)),
                              'right'
                            )
                          }
                          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-800 focus:border-sky-500 focus:outline-none"
                        />
                      </td>
                      <td className="px-1.5 py-1.5 text-center">
                        {lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLine(line.id)}
                            title="Remove line"
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

    if (activeTab === 'registries') {
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <div className="flex items-center justify-between gap-1">
                <label className="block text-xs font-medium text-slate-700">
                  Sheet No. (Auto)
                </label>
                <button
                  type="button"
                  onClick={handleGenerateNewSheetNumber}
                  className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
                >
                  + New Sheet No.
                </button>
              </div>
              <input
                type="text"
                value={sheetNumber}
                readOnly
                aria-readonly="true"
                className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-mono font-semibold text-slate-700 cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Registry Form Type
              </label>
              <select
                value={registryVariant}
                onChange={(e) =>
                  handleRegistryVariantChange(
                    e.target.value as RegistryVariantKey
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-800"
              >
                <option value="mooe">MOOE Registry</option>
                <option value="co">Capital Outlay Registry</option>
                <option value="spf">Specific Purpose Fund Registry</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Program / Project / Activity
              </label>
              <input
                type="text"
                placeholder="Enter program or activity"
                value={programActivity}
                onChange={(e) => setProgramActivity(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Certified Date (YYYY-MM-DD)
              </label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={registryCertifiedDate}
                onChange={(e) =>
                  setRegistryCertifiedDate(formatAutoDashDate(e.target.value))
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                Expenditure Columns ({expenseColumns.length})
              </span>
              {expenseColumns.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setExpenseColumns([...DEFAULT_EXPENSE_COLUMNS]);
                    setRegistryEntries((prev) =>
                      prev.map((entry) => ({
                        ...entry,
                        amount: 0,
                        expenseBreakdown: {},
                      }))
                    );
                  }}
                  className="text-[11px] font-medium text-slate-600 hover:underline cursor-pointer"
                >
                  Reset Default
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder="Add expenditure column..."
                value={newColumnDraft}
                onChange={(e) => setNewColumnDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExpenseColumn();
                  }
                }}
                className="flex-1 rounded border border-slate-300 px-2.5 py-1 text-xs"
              />
              <button
                type="button"
                onClick={addExpenseColumn}
                className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add</span>
              </button>
            </div>

            {expenseColumns.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/70 p-2 space-y-1.5">
                {expenseColumns.map((colName, idx) => (
                  <div
                    key={`exp-col-${idx}`}
                    className="flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={colName}
                      onChange={(e) => renameExpenseColumn(idx, e.target.value)}
                      className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-800"
                    />
                    <button
                      type="button"
                      onClick={() => removeExpenseColumn(idx)}
                      title="Remove column"
                      className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                Registry Entries ({computedRegistryEntries.length})
              </span>
              <button
                type="button"
                onClick={addRegistryEntry}
                className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Entry</span>
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-200">
              {computedRegistryEntries.map((entry) => (
                <div key={entry.id} className="p-2.5 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <select
                      value={entry.section}
                      onChange={(e) =>
                        updateRegistryEntry(
                          entry.id,
                          'section',
                          e.target.value as RegistryEntryRow['section']
                        )
                      }
                      className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-800"
                    >
                      <option value="budget">
                        {registryVariant === 'spf'
                          ? 'a. Specific Purpose Fund'
                          : 'a. Budget'}
                      </option>
                      <option value="commitments">b. Commitments</option>
                      <option value="payments">c. Payments</option>
                    </select>

                    {computedRegistryEntries.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRegistryEntry(entry.id)}
                        className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <input
                    type="text"
                    placeholder="Particulars"
                    value={entry.particulars}
                    onChange={(e) =>
                      updateRegistryEntry(
                        entry.id,
                        'particulars',
                        e.target.value
                      )
                    }
                    className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />

                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      type="text"
                      placeholder="YYYY-MM-DD"
                      value={entry.date}
                      onChange={(e) =>
                        updateRegistryEntry(
                          entry.id,
                          'date',
                          formatAutoDashDate(e.target.value)
                        )
                      }
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <input
                      type="text"
                      placeholder="Reference"
                      value={entry.reference}
                      onChange={(e) =>
                        updateRegistryEntry(
                          entry.id,
                          'reference',
                          e.target.value
                        )
                      }
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <div
                      title="Total Amount is automatically computed from the breakdown sum"
                      className="flex items-center justify-end rounded border border-slate-200 bg-slate-100 px-2 py-1 text-right text-xs font-semibold text-slate-800"
                    >
                      {formatWholePeso(entry.amount)}
                    </div>
                  </div>

                  {expenseColumns.length > 0 && (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2 space-y-1.5">
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                        Breakdown of Object of Expenditures
                      </span>
                      <div className="grid grid-cols-2 gap-1.5">
                        {expenseColumns.map((colName, idx) => {
                          const colVal = getBreakdownCellValue(
                            entry.expenseBreakdown,
                            colName,
                            idx
                          );
                          return (
                            <div key={`bd-input-${idx}`}>
                              <label
                                title={colName || `Column ${idx + 1}`}
                                className="block truncate text-[10px] text-slate-700"
                              >
                                {colName || `Column ${idx + 1}`}
                              </label>
                              <input
                                type="number"
                                placeholder="0"
                                value={colVal === 0 ? '' : colVal}
                                onChange={(e) =>
                                  updateRegistryBreakdown(
                                    entry.id,
                                    idx,
                                    colName,
                                    e.target.value
                                  )
                                }
                                className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 text-right text-[11px]"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    const isSpecificSummary = summaryVariant === 'spf';

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <div className="flex items-center justify-between gap-1">
              <label className="block text-xs font-medium text-slate-700">
                Summary No. (Auto)
              </label>
              <button
                type="button"
                onClick={handleGenerateNewSheetNumber}
                className="text-[11px] font-medium text-sky-700 hover:underline cursor-pointer"
              >
                + New No.
              </button>
            </div>
            <input
              type="text"
              value={sheetNumber}
              readOnly
              aria-readonly="true"
              className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-mono font-semibold text-slate-700 cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              Summary Type
            </label>
            <select
              value={summaryVariant}
              onChange={(e) => {
                const next = e.target.value as SummaryVariantKey;
                setSummaryVariant(next);
                if (next === 'spf') {
                  setSummaryRows([]);
                } else {
                  setSummaryRows(computeAutoBudgetSummaryRows());
                }
              }}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-800"
            >
              <option value="budget">Budget Summary (Auto-Sync)</option>
              <option value="spf">Specific Purpose Fund Summary</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[11px] font-medium text-slate-700">
              As of Date
            </label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
              value={asOfDate}
              onChange={(e) => setAsOfDate(formatAutoDashDate(e.target.value))}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-700">
              Prepared Date
            </label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
              value={summaryPreparedDate}
              onChange={(e) =>
                setSummaryPreparedDate(formatAutoDashDate(e.target.value))
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
              value={summaryApprovedDate}
              onChange={(e) =>
                setSummaryApprovedDate(formatAutoDashDate(e.target.value))
              }
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          </div>
        </div>

        {isSpecificSummary ? (
          <div className="space-y-2 pt-2 border-t border-slate-200">
            <label className="block text-xs font-semibold text-slate-800">
              Pick Registry to Summarize
            </label>
            <select
              value={selectedSpecificRegistryId}
              onChange={(e) => handlePickSpecificRegistry(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              <option value="">— Select a registry to add —</option>
              <option value="__current__">
                Current Draft Registry ({programActivity.trim() || 'Untitled'})
              </option>
              {registryRecords.map((rec) => (
                <option key={rec.id} value={rec.id}>
                  {rec.finalId} —{' '}
                  {rec.payload.programActivity?.trim() || rec.title}
                </option>
              ))}
            </select>

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs font-semibold text-slate-800">
                Selected Summary Lines ({summaryRows.length})
              </span>
              <button
                type="button"
                onClick={addSummaryRow}
                className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-100 transition cursor-pointer"
              >
                <Plus className="h-3 w-3" />
                <span>Add Line</span>
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-200">
              {summaryRows.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  Pick a registry above to include it in this Specific Purpose
                  Fund Summary.
                </div>
              ) : (
                summaryRows.map((row) => (
                  <div key={row.id} className="p-2.5 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-1.5">
                      <select
                        value={row.allotmentClass}
                        onChange={(e) =>
                          updateSummaryRow(
                            row.id,
                            'allotmentClass',
                            e.target.value as SummaryProgramRow['allotmentClass']
                          )
                        }
                        className="rounded border border-slate-300 bg-slate-50 px-1.5 py-1 text-[11px] font-medium"
                      >
                        <option value="MOOE">MOOE</option>
                        <option value="CO">CO</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => removeSummaryRow(row.id)}
                        className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <input
                      type="text"
                      placeholder="Program / Particulars"
                      value={row.particulars}
                      onChange={(e) =>
                        updateSummaryRow(row.id, 'particulars', e.target.value)
                      }
                      className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                    />

                    <div className="grid grid-cols-3 gap-1.5">
                      <input
                        type="number"
                        placeholder="Budget (a)"
                        value={row.budget === 0 ? '' : row.budget}
                        onChange={(e) =>
                          updateSummaryRow(
                            row.id,
                            'budget',
                            Number(e.target.value)
                          )
                        }
                        className="rounded border border-slate-300 px-2 py-1 text-right text-xs"
                      />
                      <input
                        type="number"
                        placeholder="Commitments (b)"
                        value={row.commitments === 0 ? '' : row.commitments}
                        onChange={(e) =>
                          updateSummaryRow(
                            row.id,
                            'commitments',
                            Number(e.target.value)
                          )
                        }
                        className="rounded border border-slate-300 px-2 py-1 text-right text-xs"
                      />
                      <input
                        type="number"
                        placeholder="Payments (c)"
                        value={row.payments === 0 ? '' : row.payments}
                        onChange={(e) =>
                          updateSummaryRow(
                            row.id,
                            'payments',
                            Number(e.target.value)
                          )
                        }
                        className="rounded border border-slate-300 px-2 py-1 text-right text-xs"
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2 pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-800">
                Auto-Synced Summary Lines ({summaryRows.length})
              </span>
              <span className="text-[11px] font-medium text-emerald-700">
                Synced with Registries
              </span>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/70 divide-y divide-slate-200">
              {summaryRows.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  Summary lines will populate automatically once registry entries
                  are recorded.
                </div>
              ) : (
                summaryRows.map((row) => (
                  <div key={row.id} className="p-2.5 space-y-1 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">
                        {row.particulars}
                      </span>
                      <span className="rounded bg-white border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                        {row.allotmentClass}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-600">
                      <span>Budget: {formatWholePeso(row.budget)}</span>
                      <span>
                        Commitments: {formatWholePeso(row.commitments)}
                      </span>
                      <span>Payments: {formatWholePeso(row.payments)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderPaperSheetFromPayload = (p: BudgetPayload) => {
    const docType = p.activeTab || 'program-design';

    if (docType === 'program-design') {
      const docLines = Array.isArray(p.lines) ? p.lines : [];
      const total = docLines.reduce(
        (sum, l) => sum + parseQtyCount(l.quantity) * (l.amount || 0),
        0
      );
      const blankRowCount = Math.max(0, 3 - docLines.length);

      return (
        <div className="w-full min-w-0 text-xs text-slate-900">
          <div className="w-full min-w-0 overflow-visible">
            <SkBannerHeader formTitle="PROGRAM DESIGN" />
          </div>

          <div className="mt-6 max-w-xl grid grid-cols-[110px_1fr] gap-y-1 text-xs">
            <span className="text-slate-800 py-0.5">Title</span>
            <span className="border-b border-black py-0.5 font-bold">
              {p.title || <span className="font-normal italic text-slate-400">Program title</span>}
            </span>
            <span className="text-slate-800 py-0.5">Date:</span>
            <span className="border-b border-black py-0.5">
              {p.dateText || <span className="italic text-slate-400">Date</span>}
            </span>
            <span className="text-slate-800 py-0.5">Amount</span>
            <span className="border-b border-black py-0.5">
              Php {formatWholePeso(total)}
            </span>
          </div>

          <div className="mt-7">
            <p className="mb-2 text-xs font-bold underline">Line Item Budget</p>

            <table className="w-full border-collapse border border-black text-xs">
              <thead>
                <tr>
                  <th className="border border-black px-3 py-1.5 text-left font-bold uppercase w-[36%]">
                    ITEM
                  </th>
                  <th className="border border-black px-3 py-1.5 text-left font-bold uppercase w-[22%]">
                    QUANTITY
                  </th>
                  <th className="border border-black px-3 py-1.5 text-left font-bold uppercase w-[20%]">
                    AMOUNT
                  </th>
                  <th className="border border-black px-3 py-1.5 text-left font-bold uppercase underline w-[22%]">
                    TOTAL
                  </th>
                </tr>
              </thead>
              <tbody>
                {docLines.map((l) => {
                  const rowTotal = parseQtyCount(l.quantity) * (l.amount || 0);
                  return (
                    <tr key={l.id}>
                      <td className="border border-black px-3 py-1.5">
                        {l.item || <span className="italic text-slate-400">Item description</span>}
                      </td>
                      <td className="border border-black px-3 py-1.5">
                        {l.quantity || <span className="italic text-slate-400">Qty</span>}
                      </td>
                      <td className="border border-black px-3 py-1.5">
                        {l.amount ? formatWholePeso(l.amount) : <span className="italic text-slate-400">0.00</span>}
                      </td>
                      <td className="border border-black px-3 py-1.5">
                        {rowTotal ? formatWholePeso(rowTotal) : <span className="italic text-slate-400">0.00</span>}
                      </td>
                    </tr>
                  );
                })}

                {Array.from({ length: blankRowCount }).map((_, idx) => (
                  <tr key={`blank-${idx}`}>
                    <td className="border border-black px-3 py-2.5">&nbsp;</td>
                    <td className="border border-black px-3 py-2.5">&nbsp;</td>
                    <td className="border border-black px-3 py-2.5">&nbsp;</td>
                    <td className="border border-black px-3 py-2.5">&nbsp;</td>
                  </tr>
                ))}

                <tr>
                  <td
                    colSpan={3}
                    className="border border-black px-3 py-1.5 text-right font-bold uppercase"
                  >
                    GRAND TOTAL
                  </td>
                  <td className="border border-black px-3 py-1.5 font-medium">
                    {total ? formatWholePeso(total) : <span className="italic text-slate-400">0.00</span>}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-8 text-xs">
            <div>
              <p className="text-slate-800">Prepared by:</p>
              <p className="mt-5 font-bold uppercase">{preparedBy}</p>
              <p className="text-slate-800">{preparedRole}</p>
            </div>
            <div>
              <p className="text-slate-800">Approved by:</p>
              <p className="mt-5 font-medium uppercase">{approvedBy}</p>
              <p className="text-slate-800">{approvedRole}</p>
            </div>
          </div>
        </div>
      );
    }

    if (docType === 'registries') {
      const variant = p.registryVariant || registryVariant;
      const cols = Array.isArray(p.expenseColumns)
        ? p.expenseColumns
        : DEFAULT_EXPENSE_COLUMNS;
      const rawEntries = Array.isArray(p.registryEntries)
        ? p.registryEntries
        : [];
      const entries = rawEntries.map((r) => ({
        ...r,
        amount: computeBreakdownSum(r.expenseBreakdown, cols, r.amount),
      }));

      const budgetRows = entries.filter((e) => e.section === 'budget');
      const commitmentRows = entries.filter((e) => e.section === 'commitments');
      const paymentRows = entries.filter((e) => e.section === 'payments');

      const sumSection = (rows: RegistryEntryRow[]) =>
        rows.reduce((s, r) => s + Number(r.amount || 0), 0);

      const totBudget = sumSection(budgetRows);
      const totCommit = sumSection(commitmentRows);
      const totPay = sumSection(paymentRows);
      const availBal = totBudget - totCommit;
      const unpaidComm = totCommit - totPay;

      const registryHeading =
        variant === 'spf'
          ? 'REGISTRY OF SPECIFIC PURPOSE FUND, COMMITMENTS, PAYMENTS AND BALANCES'
          : 'REGISTRY OF BUDGET, COMMITMENTS, PAYMENTS AND BALANCES';
      const subHeading =
        variant === 'co' || variant === 'spf'
          ? 'CAPITAL OUTLAY'
          : 'MAINTENANCE AND OTHER OPERATING EXPENSES';

      return (
        <div className="text-xs text-slate-900 space-y-2">
          <div className="text-center font-bold uppercase leading-snug space-y-0.5">
            <p className="text-xs underline">{registryHeading}</p>
            <p className="text-[11px]">{subHeading}</p>
          </div>

          <div className="border border-black text-[10px]">
            <div className="grid grid-cols-12 border-b border-black">
              <div className="col-span-6 border-r border-black px-2 py-0.5">
                SK of Barangay: <strong>Kauswagan</strong>
              </div>
              <div className="col-span-4 border-r border-black px-2 py-0.5">
                City/Municipality: <strong>Cagayan de Oro City</strong>
              </div>
              <div className="col-span-2 px-2 py-0.5">
                Sheet No.: <strong>{p.sheetNumber || sheetNumber}</strong>
              </div>
            </div>
            <div className="grid grid-cols-12 border-b border-black">
              <div className="col-span-6 border-r border-black px-2 py-0.5">
                Budget Monitoring Officer: <strong>{budgetOfficerName}</strong>
              </div>
              <div className="col-span-6 px-2 py-0.5">
                Province: <strong>Misamis Oriental</strong>
              </div>
            </div>
            <div className="border-b border-black px-2 py-0.5">
              Program/Project/Activity:{' '}
              <strong>{p.programActivity || ''}</strong>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[10px]">
                <thead>
                  <tr>
                    <th
                      rowSpan={cols.length > 0 ? 2 : 1}
                      className="border-r border-b border-black px-1.5 py-1 text-left w-36"
                    >
                      Particulars
                    </th>
                    <th
                      rowSpan={cols.length > 0 ? 2 : 1}
                      className="border-r border-b border-black px-1.5 py-1 text-center w-20"
                    >
                      Date
                    </th>
                    <th
                      rowSpan={cols.length > 0 ? 2 : 1}
                      className="border-r border-b border-black px-1.5 py-1 text-center w-24"
                    >
                      Reference
                    </th>
                    <th
                      rowSpan={cols.length > 0 ? 2 : 1}
                      className="border-r border-b border-black px-1.5 py-1 text-right w-20"
                    >
                      Total Amount
                    </th>
                    {cols.length > 0 && (
                      <th
                        colSpan={cols.length}
                        className="border-b border-black px-1.5 py-0.5 text-center"
                      >
                        Breakdown of Object of Expenditures
                      </th>
                    )}
                  </tr>
                  {cols.length > 0 && (
                    <tr>
                      {cols.map((colName, idx) => (
                        <th
                          key={`th-col-${idx}`}
                          className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-center font-semibold"
                        >
                          {colName}
                        </th>
                      ))}
                    </tr>
                  )}
                </thead>
                <tbody>
                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-1.5 py-0.5">
                      {variant === 'spf'
                        ? 'a. Specific Purpose Fund'
                        : 'a. Budget'}
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    {cols.map((_, idx) => (
                      <td
                        key={`hdr-a-${idx}`}
                        className="border-r border-b border-black last:border-r-0"
                      />
                    ))}
                  </tr>
                  {budgetRows.map((r) => (
                    <tr key={r.id}>
                      <td className="border-r border-b border-black px-2 py-0.5">
                        {r.particulars}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                        {r.date}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                        {r.reference}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                        {r.amount ? formatWholePeso(r.amount) : ''}
                      </td>
                      {cols.map((c, idx) => {
                        const cellVal = getBreakdownCellValue(
                          r.expenseBreakdown,
                          c,
                          idx
                        );
                        return (
                          <td
                            key={`row-a-${r.id}-${idx}`}
                            className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                          >
                            {cellVal ? formatWholePeso(cellVal) : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-2 py-0.5">
                      {variant === 'spf'
                        ? 'Total Specific Purpose Fund carried forward'
                        : 'Total Budget carried forward'}
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                      {formatWholePeso(totBudget)}
                    </td>
                    {cols.map((c, idx) => {
                      const colBudget = sumSectionByColumn(budgetRows, c, idx);
                      return (
                        <td
                          key={`tot-a-${idx}`}
                          className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                        >
                          {colBudget ? formatWholePeso(colBudget) : '-'}
                        </td>
                      );
                    })}
                  </tr>

                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-1.5 py-0.5">
                      b. Commitments
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    {cols.map((_, idx) => (
                      <td
                        key={`hdr-b-${idx}`}
                        className="border-r border-b border-black last:border-r-0"
                      />
                    ))}
                  </tr>
                  {commitmentRows.map((r) => (
                    <tr key={r.id}>
                      <td className="border-r border-b border-black px-2 py-0.5">
                        {r.particulars}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                        {r.date}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                        {r.reference}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                        {r.amount ? formatWholePeso(r.amount) : ''}
                      </td>
                      {cols.map((c, idx) => {
                        const cellVal = getBreakdownCellValue(
                          r.expenseBreakdown,
                          c,
                          idx
                        );
                        return (
                          <td
                            key={`row-b-${r.id}-${idx}`}
                            className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                          >
                            {cellVal ? formatWholePeso(cellVal) : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-2 py-0.5">
                      Total Commitments carried forward
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                      {totCommit ? formatWholePeso(totCommit) : '-'}
                    </td>
                    {cols.map((c, idx) => {
                      const colCommit = sumSectionByColumn(
                        commitmentRows,
                        c,
                        idx
                      );
                      return (
                        <td
                          key={`tot-b-${idx}`}
                          className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                        >
                          {colCommit ? formatWholePeso(colCommit) : '-'}
                        </td>
                      );
                    })}
                  </tr>

                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-1.5 py-0.5">
                      c. Payments
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    {cols.map((_, idx) => (
                      <td
                        key={`hdr-c-${idx}`}
                        className="border-r border-b border-black last:border-r-0"
                      />
                    ))}
                  </tr>
                  {paymentRows.map((r) => (
                    <tr key={r.id}>
                      <td className="border-r border-b border-black px-2 py-0.5">
                        {r.particulars}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                        {r.date}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                        {r.reference}
                      </td>
                      <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                        {r.amount ? formatWholePeso(r.amount) : ''}
                      </td>
                      {cols.map((c, idx) => {
                        const cellVal = getBreakdownCellValue(
                          r.expenseBreakdown,
                          c,
                          idx
                        );
                        return (
                          <td
                            key={`row-c-${r.id}-${idx}`}
                            className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                          >
                            {cellVal ? formatWholePeso(cellVal) : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-2 py-0.5">
                      Total Payments carried forward
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                      {totPay ? formatWholePeso(totPay) : '-'}
                    </td>
                    {cols.map((c, idx) => {
                      const colPay = sumSectionByColumn(paymentRows, c, idx);
                      return (
                        <td
                          key={`tot-c-${idx}`}
                          className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                        >
                          {colPay ? formatWholePeso(colPay) : '-'}
                        </td>
                      );
                    })}
                  </tr>

                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-1.5 py-0.5">
                      {variant === 'spf'
                        ? 'Balance, Available Specific Purpose Fund (a-b)'
                        : 'Balance, Available Budget (a-b)'}
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black px-1.5 py-0.5 text-right">
                      {formatWholePeso(availBal)}
                    </td>
                    {cols.map((c, idx) => {
                      const colAvail =
                        sumSectionByColumn(budgetRows, c, idx) -
                        sumSectionByColumn(commitmentRows, c, idx);
                      return (
                        <td
                          key={`avail-${idx}`}
                          className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-right"
                        >
                          {colAvail ? formatWholePeso(colAvail) : '-'}
                        </td>
                      );
                    })}
                  </tr>

                  <tr className="font-bold">
                    <td className="border-r border-b border-black px-1.5 py-0.5">
                      Balance, Unpaid Commitment (b-c)
                    </td>
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black" />
                    <td className="border-r border-b border-black px-1.5 py-0.5 text-center">
                      {unpaidComm ? formatWholePeso(unpaidComm) : '-'}
                    </td>
                    {cols.map((c, idx) => {
                      const colUnpaid =
                        sumSectionByColumn(commitmentRows, c, idx) -
                        sumSectionByColumn(paymentRows, c, idx);
                      return (
                        <td
                          key={`unpaid-${idx}`}
                          className="border-r border-b border-black last:border-r-0 px-1 py-0.5 text-center"
                        >
                          {colUnpaid ? formatWholePeso(colUnpaid) : '-'}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="p-2 grid grid-cols-12 gap-4 text-[10px]">
              <div className="col-span-6 space-y-4">
                <p>Prepared and Certified Correct by:</p>
                <div className="text-center w-52">
                  <p className="border-b border-black pb-0.5 font-semibold uppercase">
                    {budgetOfficerName}
                  </p>
                  <p className="pt-0.5">Signature over Printed Name of</p>
                  <p>Budget Monitoring Officer</p>
                </div>
              </div>
              <div className="col-span-6 flex items-end">
                <div className="text-center w-36">
                  <p className="border-b border-black pb-0.5">
                    {p.registryCertifiedDate || ''}
                  </p>
                  <p className="pt-0.5">Date</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const sVariant = p.summaryVariant || summaryVariant;
    const sRows = Array.isArray(p.summaryRows) ? p.summaryRows : [];
    const curRows = sRows.filter((r) => r.group === 'current');
    const conRows = sRows.filter((r) => r.group === 'continuing');

    const cBud = curRows.reduce((s, r) => s + Number(r.budget || 0), 0);
    const cCom = curRows.reduce((s, r) => s + Number(r.commitments || 0), 0);
    const cPay = curRows.reduce((s, r) => s + Number(r.payments || 0), 0);

    const nBud = conRows.reduce((s, r) => s + Number(r.budget || 0), 0);
    const nCom = conRows.reduce((s, r) => s + Number(r.commitments || 0), 0);
    const nPay = conRows.reduce((s, r) => s + Number(r.payments || 0), 0);

    const gBud = cBud + nBud;
    const gCom = cCom + nCom;
    const gPay = cPay + nPay;

    const summaryTitle =
      sVariant === 'spf'
        ? 'SUMMARY OF SPECIFIC PURPOSE FUND, COMMITMENTS, PAYMENTS AND BALANCES'
        : 'SUMMARY OF BUDGET, COMMITMENTS, PAYMENTS AND BALANCES';

    return (
      <div className="text-xs text-slate-900 space-y-3">
        <div className="text-center leading-snug space-y-0.5">
          <p className="text-[11px]">SK of Barangay Kauswagan</p>
          <p className="text-[11px]">City/Municipality: Cagayan de Oro City</p>
          <p className="text-[11px]">Province: Misamis Oriental</p>
          <p className="pt-2 text-xs font-bold uppercase">{summaryTitle}</p>
          <p className="text-[11px]">As at {p.asOfDate || ''}</p>
        </div>

        <table className="w-full border-collapse border border-black text-[10px]">
          <thead>
            <tr className="font-bold text-center">
              <th className="border border-black px-2 py-1 text-left">
                Particulars
              </th>
              <th className="border border-black px-2 py-1 w-24">
                {sVariant === 'spf'
                  ? 'Specific Purpose Fund (a)'
                  : 'Budget (a)'}
              </th>
              <th className="border border-black px-2 py-1 w-24">
                Commitments (b)
              </th>
              <th className="border border-black px-2 py-1 w-24">
                Payments (c)
              </th>
              <th className="border border-black px-2 py-1 w-28">
                {sVariant === 'spf'
                  ? 'Balance, Available Specific Purpose Fund (a-b)'
                  : 'Balance, Available Budget (a-b)'}
              </th>
              <th className="border border-black px-2 py-1 w-28">
                Balance, Unpaid Commitments (b-c)
              </th>
            </tr>
          </thead>
          <tbody>
            {sVariant === 'budget' && (
              <tr className="font-bold">
                <td colSpan={6} className="border border-black px-2 py-0.5">
                  I. Current Year Budget
                </td>
              </tr>
            )}
            {curRows.map((r) => {
              const avail = Number(r.budget || 0) - Number(r.commitments || 0);
              const unpaid =
                Number(r.commitments || 0) - Number(r.payments || 0);
              return (
                <tr key={r.id}>
                  <td className="border border-black px-2 py-0.5">
                    <div>
                      {r.programCode ? `${r.programCode} ` : ''}
                      {r.particulars}
                    </div>
                    <div className="pl-4 font-semibold">
                      {r.allotmentClass}
                    </div>
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right align-bottom">
                    {r.budget ? formatWholePeso(r.budget) : ''}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right align-bottom">
                    {r.commitments ? formatWholePeso(r.commitments) : '-'}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right align-bottom">
                    {r.payments ? formatWholePeso(r.payments) : '-'}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right align-bottom">
                    {avail ? formatWholePeso(avail) : ''}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-center align-bottom">
                    {unpaid ? formatWholePeso(unpaid) : '-'}
                  </td>
                </tr>
              );
            })}
            {sVariant === 'budget' && (
              <>
                <tr className="font-bold">
                  <td className="border border-black px-2 py-0.5">Sub-total</td>
                  <td className="border border-black px-2 py-0.5 text-right">
                    {formatWholePeso(cBud)}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right">
                    {formatWholePeso(cCom)}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right">
                    {formatWholePeso(cPay)}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-right">
                    {formatWholePeso(cBud - cCom)}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-center">
                    {cCom - cPay ? formatWholePeso(cCom - cPay) : '-'}
                  </td>
                </tr>
                <tr className="font-bold">
                  <td colSpan={6} className="border border-black px-2 py-0.5">
                    II. Continuing Budget
                  </td>
                </tr>
                {conRows.map((r) => {
                  const avail =
                    Number(r.budget || 0) - Number(r.commitments || 0);
                  const unpaid =
                    Number(r.commitments || 0) - Number(r.payments || 0);
                  return (
                    <tr key={r.id}>
                      <td className="border border-black px-2 py-0.5">
                        <div>
                          {r.programCode ? `${r.programCode} ` : ''}
                          {r.particulars}
                        </div>
                        <div className="pl-4 font-semibold">
                          {r.allotmentClass}
                        </div>
                      </td>
                      <td className="border border-black px-2 py-0.5 text-right align-bottom">
                        {r.budget ? formatWholePeso(r.budget) : ''}
                      </td>
                      <td className="border border-black px-2 py-0.5 text-right align-bottom">
                        {r.commitments ? formatWholePeso(r.commitments) : '-'}
                      </td>
                      <td className="border border-black px-2 py-0.5 text-right align-bottom">
                        {r.payments ? formatWholePeso(r.payments) : '-'}
                      </td>
                      <td className="border border-black px-2 py-0.5 text-right align-bottom">
                        {avail ? formatWholePeso(avail) : ''}
                      </td>
                      <td className="border border-black px-2 py-0.5 text-center align-bottom">
                        {unpaid ? formatWholePeso(unpaid) : '-'}
                      </td>
                    </tr>
                  );
                })}
                <tr className="font-bold">
                  <td className="border border-black px-2 py-0.5">Sub-total</td>
                  <td className="border border-black px-2 py-0.5 text-center">
                    {nBud ? formatWholePeso(nBud) : '-'}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-center">
                    {nCom ? formatWholePeso(nCom) : '-'}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-center">
                    {nPay ? formatWholePeso(nPay) : '-'}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-center">
                    {nBud - nCom ? formatWholePeso(nBud - nCom) : '-'}
                  </td>
                  <td className="border border-black px-2 py-0.5 text-center">
                    {nCom - nPay ? formatWholePeso(nCom - nPay) : '-'}
                  </td>
                </tr>
              </>
            )}

            <tr className="font-bold">
              <td className="border border-black px-2 py-0.5">Grand Total</td>
              <td className="border border-black px-2 py-0.5 text-right">
                {formatWholePeso(gBud)}
              </td>
              <td className="border border-black px-2 py-0.5 text-right">
                {formatWholePeso(gCom)}
              </td>
              <td className="border border-black px-2 py-0.5 text-right">
                {formatWholePeso(gPay)}
              </td>
              <td className="border border-black px-2 py-0.5 text-right">
                {formatWholePeso(gBud - gCom)}
              </td>
              <td className="border border-black px-2 py-0.5 text-center">
                {gCom - gPay ? formatWholePeso(gCom - gPay) : '-'}
              </td>
            </tr>

            <tr>
              <td colSpan={3} className="border border-black p-2 align-top">
                <p>Prepared and Certified Correct by:</p>
                <div className="mt-5 flex items-end gap-4 text-center">
                  <div className="flex-1">
                    <p className="border-b border-black pb-0.5 font-semibold uppercase">
                      {budgetOfficerName}
                    </p>
                    <p className="pt-0.5">Signature over Printed Name</p>
                    <p>of Budget Monitoring Officer</p>
                  </div>
                  <div className="w-24">
                    <p className="border-b border-black pb-0.5">
                      {p.summaryPreparedDate || ''}
                    </p>
                    <p className="pt-0.5">Date</p>
                  </div>
                </div>
              </td>
              <td colSpan={3} className="border border-black p-2 align-top">
                <p>Approved by:</p>
                <div className="mt-5 flex items-end gap-4 text-center">
                  <div className="flex-1">
                    <p className="border-b border-black pb-0.5 font-semibold uppercase">
                      {approvedBy}
                    </p>
                    <p className="pt-0.5">Signature over Printed Name</p>
                    <p>of SK Chairperson</p>
                  </div>
                  <div className="w-24">
                    <p className="border-b border-black pb-0.5">
                      {p.summaryApprovedDate || ''}
                    </p>
                    <p className="pt-0.5">Date</p>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  const renderRecordDocumentPreview = (rec: BudgetDbRecord) => {
    const p = rec.payload;
    const recTab = p?.activeTab || rec.docType;
    const tabDefaultOrientation =
      TABS.find((t) => t.key === recTab)?.defaultOrientation || 'portrait';
    const recPaperSize: PaperSizeKey = p?.paperSize || 'a4';
    const recOrientation: PaperOrientation =
      p?.orientation || tabDefaultOrientation;
    const spec = PAPER_DIMENSIONS[recPaperSize];
    const widthMm =
      recOrientation === 'portrait' ? spec.widthMm : spec.heightMm;
    const minHeightMm =
      recOrientation === 'portrait' ? spec.heightMm : spec.widthMm;

    return (
      <div {...panHandlers} className={`overflow-x-auto rounded-lg bg-slate-200/80 p-4 ${isPreviewDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
        <div
          style={{
            width: `${widthMm}mm`,
            minHeight: `${minHeightMm}mm`,
            padding: '20mm',
          }}
          className="mx-auto bg-white text-slate-900 shadow-lg ring-1 ring-slate-900/10"
        >
          {renderPaperSheetFromPayload({
            ...p,
            activeTab: recTab,
            sheetNumber: p?.sheetNumber || rec.finalId,
            title: p?.title || rec.title,
            dateText: p?.dateText || rec.dateText,
          })}
        </div>
      </div>
    );
  };

  const renderPaperSheetContent = () =>
    renderPaperSheetFromPayload({
      activeTab,
      paperSize,
      orientation,
      sheetNumber,
      title,
      dateText,
      lines,
      registryVariant,
      programActivity,
      expenseColumns,
      registryEntries: computedRegistryEntries,
      registryCertifiedDate,
      summaryVariant,
      asOfDate,
      summaryRows,
      summaryPreparedDate,
      summaryApprovedDate,
    });

  if (isConnectingSupabase || !isSupabaseConnected) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="inline-flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-5 py-3.5 text-xs font-medium text-slate-700 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-sky-700" />
          <span>Connecting to Database...</span>
        </div>
      </div>
    );
  }

  const filteredDbRecords = dbRecords.filter(
    (rec) =>
      rec.docType === activeTab || rec.tableName === currentTabMeta.tableName
  );

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
        finalIdPreview={
          activeTab === 'program-design' ? getCurrentRecordTitle() : sheetNumber
        }
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
                    {activeTab !== 'program-design' && (
                      <th className="px-3 py-2 text-left font-semibold">
                        Record ID
                      </th>
                    )}
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
                        colSpan={activeTab === 'program-design' ? 3 : 4}
                        className="px-3 py-6 text-center text-slate-500"
                      >
                        No saved {currentTabMeta.label} records yet.
                      </td>
                    </tr>
                  ) : (
                    filteredDbRecords.map((rec) => (
                      <tr key={rec.id} className="hover:bg-slate-50">
                        {activeTab !== 'program-design' && (
                          <td className="px-3 py-2 font-mono text-[11px] font-semibold text-sky-900">
                            {rec.finalId || 'Record'}
                          </td>
                        )}
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
                              onClick={() => void openEditDialog(rec)}
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
                  {viewingRecord.docType === 'program-design'
                    ? viewingRecord.title
                    : viewingRecord.finalId || 'Record'}
                  )
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

            <div className="overflow-y-auto pt-2">
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
                  Edit Record (
                  {editingRecord.docType === 'program-design'
                    ? editingRecord.title
                    : editingRecord.finalId || 'Record'}
                  )
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
                {deletingRecord.docType === 'program-design'
                  ? deletingRecord.title
                  : `${deletingRecord.finalId || 'Record'} — ${deletingRecord.title}`}
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
        onChange={handleTabChange}
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

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleNewDraft}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition cursor-pointer"
              >
                New
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => void requestSaveConfirmation()}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50 transition cursor-pointer"
              >
                <Save className="h-3.5 w-3.5" />
                <span>{isSaving ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </div>

          <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form ID · Automatically Generated</span>
            <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{sheetNumber}</span>
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
                  await loadBudgetRecordsFromSupabase();
                  setIsDatabaseDialogOpen(true);
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

          <div className="min-w-0 overflow-x-hidden rounded-xl border border-slate-300/80 bg-slate-200/80 p-4 print:overflow-visible print:rounded-none print:border-none print:bg-transparent print:p-0">
            

            <div ref={previewPanViewportRef} {...panHandlers} className={`min-w-0 overflow-auto print:overflow-visible ${isPreviewDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
              <div className={`preview-pan-stage flex flex-col gap-6 print:items-center print:gap-0 ${previewZoom > 100 ? 'w-max min-w-full items-start px-[50%] print:w-full print:min-w-0 print:px-0' : 'w-full min-w-0 items-center'}`}>
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
                    key={`budget-preview-page-${index}`}
                    className={`relative shrink-0 overflow-hidden bg-white shadow-lg ring-1 ring-slate-900/10 print:w-full print:shadow-none print:ring-0 ${index === activePageIndex ? 'block' : 'hidden print:block'}`}
                    style={{
                      width: previewZoom === 100
                        ? `min(100%, ${pageWidthMm}mm)`
                        : `${pageWidthMm * previewZoom / 100}mm`,
                      aspectRatio: `${pageWidthMm} / ${pageMinHeightMm}`,
                    }}
                  >
                    <img
                      src={page}
                      alt={`Budget document preview page ${index + 1}`}
                      className="block h-full w-full select-none object-fill"
                      draggable={false}
                    />
                  </div>
                )) : (
                  <div
                    className="mx-auto bg-white text-slate-900 shadow-lg ring-1 ring-slate-900/10"
                    style={{
                      width: previewZoom === 100
                        ? `min(100%, ${pageWidthMm}mm)`
                        : `${pageWidthMm * previewZoom / 100}mm`,
                      minHeight: `${pageMinHeightMm * previewZoom / 100}mm`,
                      padding: `${12 * previewZoom / 100}mm`,
                      boxSizing: 'border-box',
                    }}
                  >
                    {renderPaperSheetContent()}
                    {previewError && (
                      <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
                        Raster preview unavailable; showing the live document layout. {previewError}
                      </p>
                    )}
                  </div>
                )}
              </div>
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
                padding: '12mm',
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
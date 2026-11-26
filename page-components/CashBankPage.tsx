import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  RefreshCw,
  Copy,
  FileText,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { PageTabs } from '../../components/ui/PageTabs';
import { SaveConfirmModal } from '../../components/ui/SaveConfirmModal';
import {
  StatusDialog,
  StatusDialogState,
  INITIAL_STATUS_DIALOG,
} from '../../components/ui/StatusDialog';
import { useEnterToSave } from '../../hooks/useEnterToSave';
import { supabase } from '../../lib/supabaseConnection';

type CashBankTabKey = 'rcrd' | 'rcb' | 'checks' | 'recon';
type PaperSizeKey = 'a4' | 'letter' | 'legal';
type PaperOrientation = 'portrait' | 'landscape';
type SavedTableName =
  | 'cash_registers'
  | 'check_logbook_entries'
  | 'bank_reconciliation_statements';

type NumericField = number;

interface CommonFields {
  barangay: string;
  city: string;
  province: string;
  treasurer: string;
  preparedBy: string;
  preparedDate: string;
  fund: string;
  sheetNumber: string;
}

interface RcrdEntry {
  id: string;
  date: string;
  reference: string;
  payor: string;
  particulars: string;
  receipt: NumericField;
  deposit: NumericField;
  balance: NumericField;
  directDeposit: NumericField;
  subsidyBarangay: NumericField;
  grantSpecific: NumericField;
  grantNonSpecific: NumericField;
  refundAdvance: NumericField;
  others: NumericField;
}

interface RcbEntry {
  id: string;
  date: string;
  reference: string;
  payee: string;
  particulars: string;
  deposit: NumericField;
  withdrawal: NumericField;
  balance: NumericField;
  training: NumericField;
  officeSupplies: NumericField;
  travelling: NumericField;
  water: NumericField;
  electricity: NumericField;
  membership: NumericField;
  semiExpendable: NumericField;
  otherSupplies: NumericField;
  ictEquipment: NumericField;
  officeEquipment: NumericField;
  otherStructures: NumericField;
  advancesOfficials: NumericField;
  advancesTreasurer: NumericField;
  others: NumericField;
  vat: NumericField;
  ewt: NumericField;
}

interface CheckEntry {
  id: string;
  date: string;
  checkNumber: string;
  particulars: string;
  payee: string;
  payeeSignature: string;
  payeeDateReceived: string;
  representative: string;
  representativeSignature: string;
  representativeDateReceived: string;
  status: string;
}

interface ReconLine {
  id: string;
  label: string;
  kind: 'section' | 'entry' | 'total';
  rcb: number;
  bank: number;
  comment: string;
}

interface ReconFields {
  statementMonth: string;
  bankName: string;
  branch: string;
  accountNumber: string;
  unadjustedRcb: number;
  unadjustedBank: number;
  approvedBy: string;
  approvedDate: string;
}

interface CashBankSnapshot {
  tab: CashBankTabKey;
  id: string;
  common: CommonFields;
  rcrdOpening: number;
  rcrdRows: RcrdEntry[];
  rcbOpening: number;
  rcbRows: RcbEntry[];
  checkRows: CheckEntry[];
  recon: ReconFields;
  reconRows: ReconLine[];
}

interface SavedRecord {
  id: string;
  tableName: SavedTableName;
  finalId: string;
  title: string;
  dateText: string;
  raw: Record<string, unknown>;
}

interface ColumnConfig {
  key: keyof RcrdEntry;
  label: string;
  width: string;
  numeric?: boolean;
}

interface RcbColumnConfig {
  key: keyof RcbEntry;
  label: string;
  width: string;
  numeric?: boolean;
}

const PAPER_DIMENSIONS: Record<
  PaperSizeKey,
  { label: string; widthMm: number; heightMm: number }
> = {
  a4: { label: 'A4 (210 × 297 mm)', widthMm: 210, heightMm: 297 },
  letter: { label: 'Short / Letter (8.5 × 11 in)', widthMm: 215.9, heightMm: 279.4 },
  legal: { label: 'Long / Legal (8.5 × 14 in)', widthMm: 215.9, heightMm: 355.6 },
};

const TABS: { key: CashBankTabKey; label: string; description: string }[] = [
  {
    key: 'rcrd',
    label: 'RCRD',
    description: 'Register of Cash Receipts, Deposits and Other Related Financial Transactions',
  },
  {
    key: 'rcb',
    label: 'RCB',
    description: 'Register of Cash in Bank and Other Related Financial Transactions',
  },
  {
    key: 'checks',
    label: 'Check Logbook',
    description: 'Logbook of checks issued and cancelled',
  },
  {
    key: 'recon',
    label: 'Bank Reconciliation',
    description: 'Monthly bank statement versus book balance reconciliation',
  },
];

const RCRD_COLUMNS: ColumnConfig[] = [
  { key: 'date', label: 'Date', width: '7%' },
  { key: 'reference', label: 'Reference', width: '7%' },
  { key: 'payor', label: 'Name of Payor', width: '9%' },
  { key: 'particulars', label: 'Particulars', width: '18%' },
  { key: 'receipt', label: 'Receipt', width: '6%', numeric: true },
  { key: 'deposit', label: 'Deposit', width: '6%', numeric: true },
  { key: 'balance', label: 'Balance', width: '7%', numeric: true },
  { key: 'directDeposit', label: 'Direct Deposit', width: '6%', numeric: true },
  { key: 'subsidyBarangay', label: 'Subsidy from Barangay', width: '7%', numeric: true },
  { key: 'grantSpecific', label: 'With Specific Purpose', width: '7%', numeric: true },
  { key: 'grantNonSpecific', label: 'Without Specific Purpose', width: '7%', numeric: true },
  { key: 'refundAdvance', label: 'Refund of Cash Advances', width: '7%', numeric: true },
  { key: 'others', label: 'Others', width: '6%', numeric: true },
];

const RCRD_EDIT_FIELDS: { key: keyof RcrdEntry; label: string; numeric?: boolean }[] = [
  { key: 'date', label: 'Date' },
  { key: 'reference', label: 'Reference' },
  { key: 'payor', label: 'Name of Payor' },
  { key: 'particulars', label: 'Particulars' },
  { key: 'receipt', label: 'Receipt', numeric: true },
  { key: 'deposit', label: 'Deposit', numeric: true },
  { key: 'directDeposit', label: 'Direct Deposit', numeric: true },
  { key: 'subsidyBarangay', label: 'Subsidy from Barangay', numeric: true },
  { key: 'grantSpecific', label: 'Grant with Specific Purpose', numeric: true },
  { key: 'grantNonSpecific', label: 'Grant without Specific Purpose', numeric: true },
  { key: 'refundAdvance', label: 'Refund of Cash Advances', numeric: true },
  { key: 'others', label: 'Others', numeric: true },
];

const RCB_COLUMNS: RcbColumnConfig[] = [
  { key: 'date', label: 'Date', width: '5%' },
  { key: 'reference', label: 'Reference', width: '5%' },
  { key: 'payee', label: 'Name of Payee', width: '7%' },
  { key: 'particulars', label: 'Particulars', width: '10%' },
  { key: 'deposit', label: 'Deposit', width: '3.5%', numeric: true },
  { key: 'withdrawal', label: 'Withdrawal', width: '3.5%', numeric: true },
  { key: 'balance', label: 'Balance', width: '3.5%', numeric: true },
  { key: 'training', label: 'Training Expenses', width: '3.5%', numeric: true },
  { key: 'officeSupplies', label: 'Office Supplies Expenses', width: '3.5%', numeric: true },
  { key: 'travelling', label: 'Travelling Expenses', width: '3.5%', numeric: true },
  { key: 'water', label: 'Water Expenses', width: '3.5%', numeric: true },
  { key: 'electricity', label: 'Electricity Expenses', width: '3.5%', numeric: true },
  { key: 'membership', label: 'Membership Dues and Contribution to Organization Expenses', width: '3.5%', numeric: true },
  { key: 'semiExpendable', label: 'Semi-Expendable Property Expenses', width: '3.5%', numeric: true },
  { key: 'otherSupplies', label: 'Other Supplies and Materials Expenses', width: '3.5%', numeric: true },
  { key: 'ictEquipment', label: 'ICT Equipment', width: '4%', numeric: true },
  { key: 'officeEquipment', label: 'Office Equipment', width: '4%', numeric: true },
  { key: 'otherStructures', label: 'Other Structures', width: '4%', numeric: true },
  { key: 'advancesOfficials', label: 'Advances to SK Officials', width: '4%', numeric: true },
  { key: 'advancesTreasurer', label: 'Advances to SK Treasurer', width: '4%', numeric: true },
  { key: 'others', label: 'Others', width: '4%', numeric: true },
  { key: 'vat', label: 'VAT', width: '5.25%', numeric: true },
  { key: 'ewt', label: 'EWT', width: '5.25%', numeric: true },
];

const RCB_EDIT_FIELDS: { key: keyof RcbEntry; label: string; numeric?: boolean }[] = [
  { key: 'date', label: 'Date' },
  { key: 'reference', label: 'Reference' },
  { key: 'payee', label: 'Name of Payee' },
  { key: 'particulars', label: 'Particulars' },
  { key: 'deposit', label: 'Deposit', numeric: true },
  { key: 'withdrawal', label: 'Withdrawal', numeric: true },
  { key: 'training', label: 'Training Expenses', numeric: true },
  { key: 'officeSupplies', label: 'Office Supplies Expenses', numeric: true },
  { key: 'travelling', label: 'Travelling Expenses', numeric: true },
  { key: 'water', label: 'Water Expenses', numeric: true },
  { key: 'electricity', label: 'Electricity Expenses', numeric: true },
  { key: 'membership', label: 'Membership Dues / Contributions', numeric: true },
  { key: 'semiExpendable', label: 'Semi-Expendable Property', numeric: true },
  { key: 'otherSupplies', label: 'Other Supplies and Materials', numeric: true },
  { key: 'ictEquipment', label: 'ICT Equipment', numeric: true },
  { key: 'officeEquipment', label: 'Office Equipment', numeric: true },
  { key: 'otherStructures', label: 'Other Structures', numeric: true },
  { key: 'advancesOfficials', label: 'Advances to SK Officials', numeric: true },
  { key: 'advancesTreasurer', label: 'Advances to SK Treasurer', numeric: true },
  { key: 'others', label: 'Others', numeric: true },
  { key: 'vat', label: 'VAT', numeric: true },
  { key: 'ewt', label: 'EWT', numeric: true },
];

const CHECK_EDIT_FIELDS: { key: keyof CheckEntry; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'checkNumber', label: 'Check Number' },
  { key: 'particulars', label: 'Particulars' },
  { key: 'payee', label: 'Name of Payee' },
  { key: 'payeeSignature', label: 'Payee Signature / Reference' },
  { key: 'payeeDateReceived', label: 'Payee Date Received' },
  { key: 'representative', label: 'Authorized Representative' },
  { key: 'representativeSignature', label: 'Representative Signature / Reference' },
  { key: 'representativeDateReceived', label: 'Representative Date Received' },
];

const makeId = () => crypto.randomUUID();
const toNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const formatMoney = (value: number) =>
  value
    ? value.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : '—';
const hasText = (value: string) => Boolean(value.trim());
const todayIso = () => new Date().toISOString().slice(0, 10);

function makeRcrdEntry(): RcrdEntry {
  return {
    id: makeId(), date: '', reference: '', payor: '', particulars: '',
    receipt: 0, deposit: 0, balance: 0, directDeposit: 0, subsidyBarangay: 0,
    grantSpecific: 0, grantNonSpecific: 0, refundAdvance: 0, others: 0,
  };
}

function makeRcbEntry(): RcbEntry {
  return {
    id: makeId(), date: '', reference: '', payee: '', particulars: '',
    deposit: 0, withdrawal: 0, balance: 0, training: 0, officeSupplies: 0, travelling: 0,
    water: 0, electricity: 0, membership: 0, semiExpendable: 0,
    otherSupplies: 0, ictEquipment: 0, officeEquipment: 0, otherStructures: 0,
    advancesOfficials: 0, advancesTreasurer: 0, others: 0, vat: 0, ewt: 0,
  };
}

function makeCheckEntry(): CheckEntry {
  return {
    id: makeId(), date: '', checkNumber: '', particulars: '', payee: '',
    payeeSignature: '', payeeDateReceived: '', representative: '',
    representativeSignature: '', representativeDateReceived: '', status: 'issued',
  };
}

function makeReconRows(): ReconLine[] {
  const rows: Omit<ReconLine, 'id'>[] = [
    { label: 'Check Issued not taken up:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'In the Books', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'By the Bank', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Check Issued Overstated:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'In the Books', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'By the Bank', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Check Issued Understated:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'In the Books', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'By the Bank', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Deposits not taken up:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'In the Books', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'By the Bank', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Deposits Overstated:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'In the Books', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'By the Bank', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Deposit Understated:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'In the Books', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'By the Bank', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Bank Debit/Credit Memos, Not taken up in the books:', kind: 'section', rcb: 0, bank: 0, comment: '' },
    { label: 'Debit Memo', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Credit Memo', kind: 'entry', rcb: 0, bank: 0, comment: '' },
    { label: 'Other Reconciling Items', kind: 'entry', rcb: 0, bank: 0, comment: '' },
  ];
  return rows.map((row) => ({ ...row, id: makeId() }));
}

function moneySum<T extends Record<string, unknown>>(rows: T[], key: keyof T): number {
  return rows.reduce((sum, row) => sum + toNumber(row[key]), 0);
}

function emptyCommon(): CommonFields {
  return {
    barangay: 'Kauswagan',
    city: 'Cagayan de Oro City',
    province: 'Misamis Oriental',
    treasurer: 'JAN MACKENXIE B. NAVARRO',
    preparedBy: 'JAN MACKENXIE B. NAVARRO',
    preparedDate: todayIso(),
    fund: 'General Fund',
    sheetNumber: `${new Date().getFullYear()}-001`,
  };
}

function emptyRecon(): ReconFields {
  return {
    statementMonth: todayIso().slice(0, 7) + '-01',
    bankName: '',
    branch: '',
    accountNumber: '',
    unadjustedRcb: 0,
    unadjustedBank: 0,
    approvedBy: 'HON. RANCE EMIL D. ACHACOSO',
    approvedDate: '',
  };
}

function safeJsonArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function titleForTab(tab: CashBankTabKey): string {
  if (tab === 'rcrd') return 'REGISTER OF CASH RECEIPTS, DEPOSITS AND OTHER RELATED FINANCIAL TRANSACTIONS';
  if (tab === 'rcb') return 'REGISTER OF CASH IN BANK AND OTHER RELATED FINANCIAL TRANSACTIONS';
  if (tab === 'checks') return 'LOGBOOK OF CHECKS ISSUED AND CANCELLED';
  return 'BANK RECONCILIATION STATEMENT';
}

function displayDate(value: string): string {
  if (!value) return '';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

interface CashBankCellInputProps {
  value: string | number;
  onChange: (next: string) => void;
  readOnly: boolean;
  numeric?: boolean;
  align?: 'left' | 'right' | 'center';
}

function CashBankCellInput({
  value,
  onChange,
  readOnly,
  numeric = false,
  align = 'left',
}: CashBankCellInputProps) {
  const normalizedValue = numeric && toNumber(value) === 0 ? '' : String(value ?? '');
  const [draft, setDraft] = useState(normalizedValue);

  useEffect(() => {
    if (numeric) {
      const draftNumber = draft.trim() === '' ? 0 : toNumber(draft);
      if (draftNumber !== toNumber(value)) setDraft(normalizedValue);
    } else {
      setDraft(normalizedValue);
    }
  }, [normalizedValue, numeric, value]);

  if (readOnly) {
    return (
      <span className={align === 'right' ? 'block text-right' : align === 'center' ? 'block text-center' : 'block'}>
        {numeric ? (toNumber(value) ? formatMoney(toNumber(value)) : '') : String(value || '')}
      </span>
    );
  }

  return (
    <input
      type="text"
      inputMode={numeric ? 'decimal' : undefined}
      value={numeric ? draft : String(value ?? '')}
      onFocus={(event) => {
        if (numeric && toNumber(value) === 0) {
          setDraft('');
          event.currentTarget.value = '';
        }
        const input = event.currentTarget;
        requestAnimationFrame(() => input.select());
      }}
      onChange={(event) => {
        const raw = numeric
          ? event.target.value.replace(/[^0-9.\-]/g, '')
          : event.target.value;
        const next = numeric ? raw.replace(/^(-?)0+(?=\d)/, '$1') : raw;
        if (numeric) setDraft(next);
        onChange(next);
      }}
      className={`w-full min-w-0 border-0 bg-transparent px-0.5 py-0.5 text-[inherit] leading-tight text-slate-950 outline-none focus:bg-sky-50 focus:ring-1 focus:ring-sky-300 ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'}`}
    />
  );
}

interface CashBankNumericInputProps {
  value: number;
  onChange: (next: number) => void;
  className?: string;
}

function CashBankNumericInput({ value, onChange, className = '' }: CashBankNumericInputProps) {
  const normalizedValue = value === 0 ? '' : String(value);
  const [draft, setDraft] = useState(normalizedValue);

  useEffect(() => {
    const draftNumber = draft.trim() === '' ? 0 : toNumber(draft);
    if (draftNumber !== value) setDraft(normalizedValue);
  }, [normalizedValue, value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onFocus={(event) => {
        if (value === 0) {
          setDraft('');
          event.currentTarget.value = '';
        }
        const input = event.currentTarget;
        requestAnimationFrame(() => input.select());
      }}
      onChange={(event) => {
        const raw = event.target.value.replace(/[^0-9.\-]/g, '');
        const next = raw.replace(/^(-?)0+(?=\d)/, '$1');
        setDraft(next);
        onChange(toNumber(next));
      }}
      className={className}
    />
  );
}

export function CashBankPage() {
  const [activeTab, setActiveTab] = useState<CashBankTabKey>('rcrd');
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('a4');
  const [orientation, setOrientation] = useState<PaperOrientation>('landscape');
  const [previewZoom, setPreviewZoom] = useState(100);
  const [currentId, setCurrentId] = useState(makeId);
  const [common, setCommon] = useState<CommonFields>(emptyCommon);
  const [rcrdOpening, setRcrdOpening] = useState(0);
  const [rcrdRows, setRcrdRows] = useState<RcrdEntry[]>(() => Array.from({ length: 8 }, makeRcrdEntry));
  const [rcbOpening, setRcbOpening] = useState(0);
  const [rcbRows, setRcbRows] = useState<RcbEntry[]>(() => Array.from({ length: 9 }, makeRcbEntry));
  const [checkRows, setCheckRows] = useState<CheckEntry[]>(() => Array.from({ length: 21 }, makeCheckEntry));
  const [recon, setRecon] = useState<ReconFields>(emptyRecon);
  const [reconRows, setReconRows] = useState<ReconLine[]>(makeReconRows);

  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [isDatabaseDialogOpen, setIsDatabaseDialogOpen] = useState(false);
  const [isLoadingDatabase, setIsLoadingDatabase] = useState(false);
  const [savedRecords, setSavedRecords] = useState<SavedRecord[]>([]);
  const [databaseSearch, setDatabaseSearch] = useState('');
  const [viewingRecord, setViewingRecord] = useState<SavedRecord | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<SavedRecord | null>(null);
  const [statusDialog, setStatusDialog] = useState<StatusDialogState>(INITIAL_STATUS_DIALOG);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const [previewViewportWidth, setPreviewViewportWidth] = useState(0);
  const skipAutoSheetNumberRef = useRef(false);
  const { panHandlers, isDragging: isPreviewDragging } = useDragToPan();

  const currentTabMeta = TABS.find((tab) => tab.key === activeTab) ?? TABS[0];
  const pageWidthMm =
    orientation === 'portrait'
      ? PAPER_DIMENSIONS[paperSize].widthMm
      : PAPER_DIMENSIONS[paperSize].heightMm;
  const pageHeightMm =
    orientation === 'portrait'
      ? PAPER_DIMENSIONS[paperSize].heightMm
      : PAPER_DIMENSIONS[paperSize].widthMm;
  const pageWidthPx = (pageWidthMm * 96) / 25.4;
  const pageHeightPx = (pageHeightMm * 96) / 25.4;
  const previewFitScale = previewViewportWidth > 0
    ? Math.max(0.1, Math.min(1, (previewViewportWidth - 34) / pageWidthPx))
    : 0.72;
  const previewScale = previewFitScale * (previewZoom / 100);
  const scaledPageWidthPx = pageWidthPx * previewScale;
  const scaledPageHeightPx = pageHeightPx * previewScale;
  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const frame = requestAnimationFrame(() => {
      viewport.scrollLeft = previewZoom > 100
        ? Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2)
        : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [previewZoom, previewViewportWidth, scaledPageWidthPx]);

  const showStatus = useCallback(
    (type: StatusDialogState['type'], title: string, message: string, detail?: string) => {
      setStatusDialog({ open: true, type, title, message, detail });
    },
    []
  );
  const closeStatusDialog = useCallback(() => {
    setStatusDialog((previous) => ({ ...previous, open: false, hideButtons: false }));
  }, []);

  const assignNextSheetNumber = useCallback(async (registerType: 'rcrd' | 'rcb') => {
    const year = new Date().getFullYear();
    const db = supabase as any;
    const { data, error } = await db
      .from('cash_registers')
      .select('sheet_number')
      .eq('register_type', registerType);
    if (error) throw new Error(error.message);

    const highest = (data ?? []).reduce((currentMax: number, row: { sheet_number?: string | null }) => {
      const match = String(row.sheet_number ?? '').match(new RegExp(`^${year}-(\\d+)$`));
      return match ? Math.max(currentMax, Number(match[1]) || 0) : currentMax;
    }, 0);
    const nextNumber = `${year}-${String(highest + 1).padStart(3, '0')}`;
    setCommon((previous) => ({ ...previous, sheetNumber: nextNumber }));
    return nextNumber;
  }, []);

  // Generate the first/new sheet number automatically, without requiring a user action.
  useEffect(() => {
    if (activeTab !== 'rcrd' && activeTab !== 'rcb') return;
    if (skipAutoSheetNumberRef.current) {
      skipAutoSheetNumberRef.current = false;
      return;
    }
    let active = true;
    const loadNextNumber = async () => {
      try {
        const year = new Date().getFullYear();
        const db = supabase as any;
        const { data, error } = await db
          .from('cash_registers')
          .select('sheet_number')
          .eq('register_type', activeTab);
        if (error) throw new Error(error.message);
        const highest = (data ?? []).reduce((currentMax: number, row: { sheet_number?: string | null }) => {
          const match = String(row.sheet_number ?? '').match(new RegExp(`^${year}-(\\d+)$`));
          return match ? Math.max(currentMax, Number(match[1]) || 0) : currentMax;
        }, 0);
        if (active) {
          setCommon((previous) => ({
            ...previous,
            sheetNumber: `${year}-${String(highest + 1).padStart(3, '0')}`,
          }));
        }
      } catch (error) {
        console.warn('Unable to generate the next Cash & Bank sheet number:', error);
      }
    };
    void loadNextNumber();
    return () => { active = false; };
  }, [activeTab]);

  // Measure the preview viewport so 100% always means fit-to-width.
  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const measure = () => setPreviewViewportWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const currentSnapshot: CashBankSnapshot = useMemo(() => ({
    tab: activeTab,
    id: currentId,
    common,
    rcrdOpening,
    rcrdRows,
    rcbOpening,
    rcbRows,
    checkRows,
    recon,
    reconRows,
  }), [activeTab, currentId, common, rcrdOpening, rcrdRows, rcbOpening, rcbRows, checkRows, recon, reconRows]);

  const currentRecordTitle = useMemo(() => {
    if (activeTab === 'rcrd') return `${common.fund || 'Cash Receipts'} — ${common.sheetNumber}`;
    if (activeTab === 'rcb') return `${common.fund || 'Cash in Bank'} — ${common.sheetNumber}`;
    if (activeTab === 'checks') {
      const populated = checkRows.find((row) => hasText(row.checkNumber) || hasText(row.payee));
      return populated ? `${populated.checkNumber || 'Check'} — ${populated.payee || populated.particulars}` : 'Check Logbook';
    }
    return `${recon.bankName || 'Bank'} — ${recon.statementMonth}`;
  }, [activeTab, common.fund, common.sheetNumber, checkRows, recon.bankName, recon.statementMonth]);

  const currentFinalId = activeTab === 'checks'
    ? checkRows.find((row) => hasText(row.checkNumber))?.checkNumber || 'Check Logbook'
    : activeTab === 'recon'
      ? recon.statementMonth
      : common.sheetNumber;

  const setCommonField = <K extends keyof CommonFields>(key: K, value: CommonFields[K]) => {
    setCommon((previous) => ({ ...previous, [key]: value }));
  };

  const setReconField = <K extends keyof ReconFields>(key: K, value: ReconFields[K]) => {
    setRecon((previous) => ({ ...previous, [key]: value }));
  };

  const updateRcrd = <K extends keyof RcrdEntry>(id: string, key: K, value: RcrdEntry[K]) => {
    setRcrdRows((previous) => previous.map((row) => row.id === id ? { ...row, [key]: value } : row));
  };
  const updateRcb = <K extends keyof RcbEntry>(id: string, key: K, value: RcbEntry[K]) => {
    setRcbRows((previous) => previous.map((row) => row.id === id ? { ...row, [key]: value } : row));
  };
  const updateCheck = <K extends keyof CheckEntry>(id: string, key: K, value: CheckEntry[K]) => {
    setCheckRows((previous) => previous.map((row) => row.id === id ? { ...row, [key]: value } : row));
  };
  const updateReconLine = <K extends keyof ReconLine>(id: string, key: K, value: ReconLine[K]) => {
    setReconRows((previous) => previous.map((row) => row.id === id ? { ...row, [key]: value } : row));
  };

  const resetCurrentForm = () => {
    setCurrentId(makeId());
    setCommon(emptyCommon());
    if (activeTab === 'rcrd') {
      setRcrdOpening(0);
      setRcrdRows(Array.from({ length: 8 }, makeRcrdEntry));
    } else if (activeTab === 'rcb') {
      setRcbOpening(0);
      setRcbRows(Array.from({ length: 9 }, makeRcbEntry));
    } else if (activeTab === 'checks') {
      setCheckRows(Array.from({ length: 21 }, makeCheckEntry));
    } else {
      setRecon(emptyRecon());
      setReconRows(makeReconRows());
    }
    setPreviewZoom(100);
    if (activeTab === 'rcrd' || activeTab === 'rcb') {
      void assignNextSheetNumber(activeTab).catch((error) => {
        console.warn('Unable to generate the next sheet number:', error);
      });
    }
  };

  const loadDatabaseRecords = useCallback(async () => {
    setIsLoadingDatabase(true);
    try {
      const db = supabase as any;
      let result: { data: Record<string, unknown>[] | null; error: { message: string } | null };
      if (activeTab === 'rcrd' || activeTab === 'rcb') {
        result = await db.from('cash_registers').select('*').eq('register_type', activeTab).order('created_at', { ascending: false }).limit(200);
      } else if (activeTab === 'checks') {
        result = await db.from('check_logbook_entries').select('*').order('entry_date', { ascending: false }).limit(300);
      } else {
        result = await db.from('bank_reconciliation_statements').select('*').order('statement_month', { ascending: false }).limit(200);
      }
      if (result.error) throw new Error(result.error.message);

      const mapped: SavedRecord[] = (result.data ?? []).map((row) => {
        if (activeTab === 'rcrd' || activeTab === 'rcb') {
          return {
            id: String(row.id),
            tableName: 'cash_registers',
            finalId: String(row.sheet_number || row.id),
            title: `${String(row.fund || 'Fund')} — ${activeTab.toUpperCase()}`,
            dateText: String(row.prepared_date || row.created_at || ''),
            raw: row,
          };
        }
        if (activeTab === 'checks') {
          return {
            id: String(row.id),
            tableName: 'check_logbook_entries',
            finalId: String(row.check_number || row.id),
            title: `${String(row.payee_name || 'Unassigned Payee')} — ${String(row.particulars || 'Check entry')}`,
            dateText: String(row.entry_date || ''),
            raw: row,
          };
        }
        return {
          id: String(row.id),
          tableName: 'bank_reconciliation_statements',
          finalId: String(row.statement_month || row.id),
          title: `${String(row.bank_name || 'Bank')} — ${String(row.branch || 'Statement')}`,
          dateText: String(row.statement_month || ''),
          raw: row,
        };
      });
      setSavedRecords(mapped);
    } catch (error) {
      showStatus('error', 'Database Load Failed', 'Unable to load Cash & Bank records from Supabase.', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setIsLoadingDatabase(false);
    }
  }, [activeTab, showStatus]);

  const openDatabase = async () => {
    await loadDatabaseRecords();
    setDatabaseSearch('');
    setIsDatabaseDialogOpen(true);
  };

  const buildCashRegisterRow = async () => {
    const authResult = await supabase.auth.getUser();
    const actor = authResult.data.user?.email || authResult.data.user?.id || null;
    const rows = activeTab === 'rcrd' ? rcrdRows : rcbRows;
    const entries = rows.filter((row) =>
      Object.entries(row).some(([key, value]) => key !== 'id' && (typeof value === 'string' ? value.trim() !== '' : toNumber(value) !== 0))
    );
    const isRcrd = activeTab === 'rcrd';
    const moneyKeys = isRcrd
      ? ['receipt', 'deposit', 'directDeposit', 'subsidyBarangay', 'grantSpecific', 'grantNonSpecific', 'refundAdvance', 'others']
      : ['deposit', 'withdrawal', 'training', 'officeSupplies', 'travelling', 'water', 'electricity', 'membership', 'semiExpendable', 'otherSupplies', 'ictEquipment', 'officeEquipment', 'otherStructures', 'advancesOfficials', 'advancesTreasurer', 'others', 'vat', 'ewt'];
    const totalByKey: Record<string, number> = {};
    for (const key of moneyKeys) {
      totalByKey[key] = entries.reduce((sum, row) => sum + toNumber((row as Record<string, unknown>)[key]), 0);
    }
    const opening = isRcrd ? rcrdOpening : rcbOpening;
    const closing = isRcrd
      ? opening + totalByKey.receipt - totalByKey.deposit
      : opening + totalByKey.deposit - totalByKey.withdrawal;
    return {
      id: currentId,
      register_type: activeTab,
      sheet_number: common.sheetNumber || `${new Date().getFullYear()}-001`,
      fund: common.fund || null,
      barangay: common.barangay || 'Kauswagan',
      city: common.city || 'Cagayan de Oro City',
      province: common.province || 'Misamis Oriental',
      sk_treasurer_name: common.treasurer || null,
      breakdown_columns: (isRcrd ? RCRD_COLUMNS : RCB_COLUMNS).map(({ key, label }) => ({ key, label })),
      totals_brought_forward: { opening_balance: opening },
      entries,
      totals_for_quarter: totalByKey,
      totals_carried_forward: { closing_balance: closing },
      prepared_by_name: common.preparedBy || null,
      prepared_date: common.preparedDate || null,
      created_by: actor,
    };
  };

  const saveCurrentRecord = async () => {
    setIsSaving(true);
    try {
      const db = supabase as any;
      if (activeTab === 'rcrd' || activeTab === 'rcb') {
        const payload = await buildCashRegisterRow();
        const { error } = await db.from('cash_registers').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(error.message);
      } else if (activeTab === 'checks') {
        const populated = checkRows.filter((row) =>
          [row.date, row.checkNumber, row.particulars, row.payee, row.payeeSignature, row.payeeDateReceived, row.representative, row.representativeSignature, row.representativeDateReceived].some(hasText)
        );
        if (populated.length === 0) {
          showStatus('warning', 'No Check Entries', 'Add at least one check entry before saving.');
          setIsSaving(false);
          return;
        }
        const invalid = populated.find((row) => !row.date || !row.checkNumber.trim() || !row.particulars.trim() || !row.payee.trim());
        if (invalid) {
          showStatus('warning', 'Required Check Information', 'Each saved check needs a Date, Check No., Particulars, and Name of Payee.', `Check row: ${invalid.checkNumber || 'not numbered'}`);
          setIsSaving(false);
          return;
        }
        const payload = populated.map((row) => ({
          id: row.id,
          barangay: common.barangay || 'Kauswagan',
          city: common.city || 'Cagayan de Oro City',
          province: common.province || 'Misamis Oriental',
          entry_date: row.date,
          check_number: row.checkNumber,
          particulars: row.particulars,
          status: row.status || 'issued',
          amount: 0,
          payee_name: row.payee,
          payee_signature_ref: row.payeeSignature || null,
          payee_date_received: row.payeeDateReceived || null,
          authorized_rep_name: row.representative || null,
          authorized_rep_signature_ref: row.representativeSignature || null,
          authorized_rep_date_received: row.representativeDateReceived || null,
        }));
        const { error } = await db.from('check_logbook_entries').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(error.message);
      } else {
        if (!recon.statementMonth || !recon.bankName.trim()) {
          showStatus('warning', 'Required Information', 'Enter the statement month and bank name before saving.');
          setIsSaving(false);
          return;
        }
        const authResult = await supabase.auth.getUser();
        const actor = authResult.data.user?.email || authResult.data.user?.id || null;
        const adjustedRcb = recon.unadjustedRcb + reconRows.reduce((sum, row) => sum + (row.kind === 'entry' ? toNumber(row.rcb) : 0), 0);
        const adjustedBank = recon.unadjustedBank + reconRows.reduce((sum, row) => sum + (row.kind === 'entry' ? toNumber(row.bank) : 0), 0);
        const payload = {
          id: currentId,
          statement_month: recon.statementMonth,
          barangay: common.barangay || 'Kauswagan',
          city: common.city || 'Cagayan de Oro City',
          province: common.province || 'Misamis Oriental',
          bank_name: recon.bankName,
          branch: recon.branch || null,
          current_account_number: recon.accountNumber || null,
          unadjusted_rcb_balance: recon.unadjustedRcb,
          unadjusted_bank_balance: recon.unadjustedBank,
          unadjusted_comment: '',
          reconciling_items: reconRows,
          adjusted_rcb_balance: adjustedRcb,
          adjusted_bank_balance: adjustedBank,
          prepared_by_name: common.preparedBy || null,
          prepared_date: common.preparedDate || null,
          approved_by_name: recon.approvedBy || null,
          approved_date: recon.approvedDate || null,
          created_by: actor,
        };
        const { error } = await db.from('bank_reconciliation_statements').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(error.message);
      }

      setSaveConfirmOpen(false);
      showStatus('success', 'Record Saved', `${currentTabMeta.label} record has been saved to the SK Desk database.`, `Reference: ${currentFinalId}`);
      if (isDatabaseDialogOpen) await loadDatabaseRecords();
    } catch (error) {
      showStatus('error', 'Save Failed', 'The record could not be saved to Supabase.', error instanceof Error ? error.message : 'Please check your connection and database columns.');
    } finally {
      setIsSaving(false);
    }
  };

  const requestSave = () => {
    if (!navigator.onLine) {
      showStatus('warning', 'No Internet Connection', 'Connect to the internet before saving this record to Supabase.');
      return;
    }
    setSaveConfirmOpen(true);
  };

  const loadSavedRecordIntoEditor = (record: SavedRecord) => {
    const raw = record.raw;
    setCurrentId(record.id);
    if (record.tableName === 'cash_registers') {
      const tab = String(raw.register_type) === 'rcb' ? 'rcb' : 'rcrd';
      if (tab !== activeTab) skipAutoSheetNumberRef.current = true;
      setActiveTab(tab);
      setOrientation('landscape');
      setPaperSize('a4');
      setCommon({
        barangay: String(raw.barangay || 'Kauswagan'),
        city: String(raw.city || 'Cagayan de Oro City'),
        province: String(raw.province || 'Misamis Oriental'),
        treasurer: String(raw.sk_treasurer_name || ''),
        preparedBy: String(raw.prepared_by_name || ''),
        preparedDate: String(raw.prepared_date || ''),
        fund: String(raw.fund || 'General Fund'),
        sheetNumber: String(raw.sheet_number || ''),
      });
      const opening = toNumber((raw.totals_brought_forward as Record<string, unknown> | null)?.opening_balance);
      const entries = safeJsonArray<Record<string, unknown>>(raw.entries, []);
      if (tab === 'rcrd') {
        setRcrdOpening(opening);
        setRcrdRows(entries.length ? entries.map((item) => ({ ...makeRcrdEntry(), ...item } as RcrdEntry)) : Array.from({ length: 8 }, makeRcrdEntry));
      } else {
        setRcbOpening(opening);
        setRcbRows(entries.length ? entries.map((item) => ({ ...makeRcbEntry(), ...item } as RcbEntry)) : Array.from({ length: 9 }, makeRcbEntry));
      }
    } else if (record.tableName === 'check_logbook_entries') {
      setActiveTab('checks');
      setOrientation('landscape');
      setPaperSize('a4');
      setCommon((previous) => ({
        ...previous,
        barangay: String(raw.barangay || 'Kauswagan'),
        city: String(raw.city || 'Cagayan de Oro City'),
        province: String(raw.province || 'Misamis Oriental'),
      }));
      setCheckRows([{
        id: record.id,
        date: String(raw.entry_date || ''),
        checkNumber: String(raw.check_number || ''),
        particulars: String(raw.particulars || ''),
        payee: String(raw.payee_name || ''),
        payeeSignature: String(raw.payee_signature_ref || ''),
        payeeDateReceived: String(raw.payee_date_received || ''),
        representative: String(raw.authorized_rep_name || ''),
        representativeSignature: String(raw.authorized_rep_signature_ref || ''),
        representativeDateReceived: String(raw.authorized_rep_date_received || ''),
        status: String(raw.status || 'issued'),
      }, ...Array.from({ length: 20 }, makeCheckEntry)]);
    } else {
      setActiveTab('recon');
      setOrientation('portrait');
      setPaperSize('a4');
      setCommon((previous) => ({
        ...previous,
        barangay: String(raw.barangay || 'Kauswagan'),
        city: String(raw.city || 'Cagayan de Oro City'),
        province: String(raw.province || 'Misamis Oriental'),
        preparedBy: String(raw.prepared_by_name || ''),
        preparedDate: String(raw.prepared_date || ''),
      }));
      setRecon({
        statementMonth: String(raw.statement_month || ''),
        bankName: String(raw.bank_name || ''),
        branch: String(raw.branch || ''),
        accountNumber: String(raw.current_account_number || ''),
        unadjustedRcb: toNumber(raw.unadjusted_rcb_balance),
        unadjustedBank: toNumber(raw.unadjusted_bank_balance),
        approvedBy: String(raw.approved_by_name || ''),
        approvedDate: String(raw.approved_date || ''),
      });
      setReconRows(safeJsonArray<ReconLine>(raw.reconciling_items, makeReconRows()).map((row) => ({ ...row, id: row.id || makeId() })));
    }
    setPreviewZoom(100);
    setIsDatabaseDialogOpen(false);
    setViewingRecord(null);
    showStatus('info', 'Record Loaded', `${record.finalId} is now loaded into the editor. Review it before saving any changes.`);
  };

  const deleteSavedRecord = async () => {
    if (!deletingRecord) return;
    try {
      const db = supabase as any;
      const { error } = await db.from(deletingRecord.tableName).delete().eq('id', deletingRecord.id);
      if (error) throw new Error(error.message);
      setDeletingRecord(null);
      showStatus('success', 'Record Deleted', `${deletingRecord.finalId} has been deleted from the database.`);
      await loadDatabaseRecords();
    } catch (error) {
      showStatus('error', 'Delete Failed', 'The selected record could not be deleted.', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  const makeSnapshotFromSaved = (record: SavedRecord): CashBankSnapshot => {
    const raw = record.raw;
    const snapshot: CashBankSnapshot = {
      tab: activeTab,
      id: record.id,
      common: {
        barangay: String(raw.barangay || 'Kauswagan'),
        city: String(raw.city || 'Cagayan de Oro City'),
        province: String(raw.province || 'Misamis Oriental'),
        treasurer: String(raw.sk_treasurer_name || ''),
        preparedBy: String(raw.prepared_by_name || ''),
        preparedDate: String(raw.prepared_date || ''),
        fund: String(raw.fund || 'General Fund'),
        sheetNumber: String(raw.sheet_number || record.finalId),
      },
      rcrdOpening: toNumber((raw.totals_brought_forward as Record<string, unknown> | null)?.opening_balance),
      rcrdRows: [],
      rcbOpening: toNumber((raw.totals_brought_forward as Record<string, unknown> | null)?.opening_balance),
      rcbRows: [],
      checkRows: [],
      recon: {
        statementMonth: String(raw.statement_month || ''),
        bankName: String(raw.bank_name || ''),
        branch: String(raw.branch || ''),
        accountNumber: String(raw.current_account_number || ''),
        unadjustedRcb: toNumber(raw.unadjusted_rcb_balance),
        unadjustedBank: toNumber(raw.unadjusted_bank_balance),
        approvedBy: String(raw.approved_by_name || ''),
        approvedDate: String(raw.approved_date || ''),
      },
      reconRows: safeJsonArray<ReconLine>(raw.reconciling_items, []),
    };
    if (record.tableName === 'cash_registers') {
      const rows = safeJsonArray<Record<string, unknown>>(raw.entries, []);
      if (String(raw.register_type) === 'rcb') {
        snapshot.tab = 'rcb';
        snapshot.rcbRows = rows.map((row) => ({ ...makeRcbEntry(), ...row } as RcbEntry));
      } else {
        snapshot.tab = 'rcrd';
        snapshot.rcrdRows = rows.map((row) => ({ ...makeRcrdEntry(), ...row } as RcrdEntry));
      }
    } else if (record.tableName === 'check_logbook_entries') {
      snapshot.tab = 'checks';
      snapshot.checkRows = [{
        id: record.id,
        date: String(raw.entry_date || ''),
        checkNumber: String(raw.check_number || ''),
        particulars: String(raw.particulars || ''),
        payee: String(raw.payee_name || ''),
        payeeSignature: String(raw.payee_signature_ref || ''),
        payeeDateReceived: String(raw.payee_date_received || ''),
        representative: String(raw.authorized_rep_name || ''),
        representativeSignature: String(raw.authorized_rep_signature_ref || ''),
        representativeDateReceived: String(raw.authorized_rep_date_received || ''),
        status: String(raw.status || 'issued'),
      }];
    } else {
      snapshot.tab = 'recon';
    }
    return snapshot;
  };

  const handlePrint = () => {
    closeStatusDialog();
    window.setTimeout(() => window.print(), 100);
  };

  const handlePrintSavedRecord = () => {
    const cleanup = () => {
      document.body.classList.remove('cashbank-print-saved');
      window.removeEventListener('afterprint', cleanup);
    };
    document.body.classList.add('cashbank-print-saved');
    window.addEventListener('afterprint', cleanup);
    window.setTimeout(() => window.print(), 120);
  };

  const handleDownloadPdf = async () => {
    const sheet = sheetRef.current;
    if (!sheet || isDownloadingPdf) return;
    setIsDownloadingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas-pro'),
        import('jspdf'),
      ]);
      const clone = sheet.cloneNode(true) as HTMLElement;
      clone.style.width = `${pageWidthMm}mm`;
      clone.style.minHeight = `${pageHeightMm}mm`;
      clone.style.height = `${pageHeightMm}mm`;
      clone.style.transform = 'none';
      clone.style.margin = '0';
      clone.style.boxShadow = 'none';
      clone.querySelectorAll<HTMLElement>('*').forEach((node) => {
        node.style.boxSizing = 'border-box';
        node.style.maxWidth = '100%';
      });
      clone.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
        const value = document.createElement('span');
        value.textContent = input.value;
        value.style.display = 'inline-block';
        value.style.width = '100%';
        value.style.minHeight = '1em';
        input.replaceWith(value);
      });
      const holder = document.createElement('div');
      holder.style.position = 'fixed';
      holder.style.left = '-10000px';
      holder.style.top = '0';
      holder.style.width = `${pageWidthMm}mm`;
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
      const pdf = new jsPDF({ unit: 'mm', format: [pageWidthMm, pageHeightMm], orientation });
      const pxPerMm = canvas.width / pageWidthMm;
      const pageHeightPx = Math.floor(pageHeightMm * pxPerMm);
      let y = 0;
      let page = 0;
      while (y < canvas.height) {
        const sliceHeight = Math.min(pageHeightPx, canvas.height - y);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = sliceHeight;
        const context = pageCanvas.getContext('2d');
        if (!context) throw new Error('Canvas rendering is not supported by this browser.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        context.drawImage(canvas, 0, y, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
        if (page > 0) pdf.addPage();
        pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.98), 'JPEG', 0, 0, pageWidthMm, sliceHeight / pxPerMm);
        y += pageHeightPx;
        page += 1;
      }
      const filePart = String(currentFinalId || activeTab).replace(/[^a-zA-Z0-9._-]+/g, '_');
      pdf.save(`${activeTab.toUpperCase()}_${filePart}.pdf`);
      showStatus('success', 'PDF Downloaded', `${activeTab.toUpperCase()}_${filePart}.pdf was generated.`);
    } catch (error) {
      showStatus('error', 'PDF Download Failed', 'Unable to create a PDF from this form.', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  useEnterToSave({
    enabled: !saveConfirmOpen && !isDatabaseDialogOpen && !viewingRecord && !deletingRecord && !statusDialog.open,
    onTriggerSave: requestSave,
  });

  const cellInput = (
    value: string | number,
    onChange: (next: string) => void,
    readOnly: boolean,
    numeric = false,
    align: 'left' | 'right' | 'center' = 'left'
  ) => (
    <CashBankCellInput
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      numeric={numeric}
      align={align}
    />
  );

  const documentHeader = (snapshot: CashBankSnapshot, title: string) => (
    <>
      <h1 className="mb-2 text-center text-[10px] font-bold leading-tight tracking-wide">{title}</h1>
      <table className="mb-0 w-full border-collapse text-[7px] leading-tight">
        <tbody>
          <tr>
            <td className="w-1/2 border border-black px-1 py-0.5">SK of Barangay: {snapshot.common.barangay}</td>
            <td className="w-1/2 border border-black px-1 py-0.5">City/Municipality: {snapshot.common.city}</td>
          </tr>
          <tr>
            <td className="border border-black px-1 py-0.5">SK Treasurer: {snapshot.common.treasurer}</td>
            <td className="border border-black px-1 py-0.5">Province: {snapshot.common.province}</td>
          </tr>
          <tr>
            <td className="border border-black px-1 py-0.5">Fund: {snapshot.common.fund}</td>
            <td className="border border-black px-1 py-0.5">Sheet No.: {snapshot.common.sheetNumber}</td>
          </tr>
        </tbody>
      </table>
    </>
  );

  const renderRcrdDocument = (snapshot: CashBankSnapshot, readOnly: boolean) => {
    const entries = snapshot.rcrdRows;
    const totals = Object.fromEntries(RCRD_COLUMNS.filter((col) => col.numeric).map((col) => [col.key, moneySum(entries as unknown as Record<string, unknown>[], col.key)])) as Record<string, number>;
    let runningBalance = snapshot.rcrdOpening;
    const balancesById = new Map<string, number>();
    entries.forEach((row) => {
      runningBalance += toNumber(row.receipt) - toNumber(row.deposit);
      balancesById.set(row.id, runningBalance);
    });
    const filledRows = entries.filter((row) => row.date || row.reference || row.payor || row.particulars || RCRD_COLUMNS.some((col) => col.numeric && toNumber(row[col.key]) !== 0));
    const displayRows = readOnly ? (filledRows.length ? filledRows : entries) : entries;
    return (
      <div className="cashbank-paper-content text-[7px] text-slate-950">
        {documentHeader(snapshot, titleForTab('rcrd'))}
        <table className="mt-0 w-full table-fixed border-collapse border border-black text-[6.5px] leading-[1.15]">
          <colgroup>{RCRD_COLUMNS.map((col) => <col key={col.key} style={{ width: col.width }} />)}</colgroup>
          <thead>
            <tr className="text-center">
              <th rowSpan={3} className="border border-black px-0.5 py-1">Date</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Reference</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Name of Payor</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Particulars</th>
              <th colSpan={3} className="border border-black px-0.5 py-1">Cash on Hand</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Direct Deposit</th>
              <th colSpan={3} className="border border-black px-0.5 py-1">Breakdown of Receipts / Direct Deposit</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Refund of Cash Advances</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Others</th>
            </tr>
            <tr className="text-center">
              <th rowSpan={2} className="border border-black px-0.5 py-1">Receipt</th>
              <th rowSpan={2} className="border border-black px-0.5 py-1">Deposit</th>
              <th rowSpan={2} className="border border-black px-0.5 py-1">Balance</th>
              <th rowSpan={2} className="border border-black px-0.5 py-1">Subsidy from Barangay</th>
              <th colSpan={2} className="border border-black px-0.5 py-1">Grants and Donations in Cash</th>
            </tr>
            <tr className="text-center">
              <th className="border border-black px-0.5 py-1">With Specific Purpose</th>
              <th className="border border-black px-0.5 py-1">Without Specific Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr className="italic">
              <td colSpan={4} className="border border-black px-1 py-1 text-right">Totals/Balance brought forward</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(snapshot.rcrdOpening)}</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
              <td colSpan={3} className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
            </tr>
            {displayRows.map((row, index) => {
              const editable = (key: keyof RcrdEntry, numeric = false, align: 'left' | 'right' | 'center' = 'left') => cellInput(
                row[key] as string | number,
                (next) => updateRcrd(row.id, key, (numeric ? toNumber(next) : next) as RcrdEntry[typeof key]),
                readOnly,
                numeric,
                align
              );
              return (
                <tr key={row.id} className="min-h-[16px]">
                  <td className="border border-black px-0.5 py-1">{editable('date')}</td>
                  <td className="border border-black px-0.5 py-1">{editable('reference')}</td>
                  <td className="border border-black px-0.5 py-1">{editable('payor')}</td>
                  <td className="border border-black px-0.5 py-1">{editable('particulars')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('receipt', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('deposit', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{formatMoney(balancesById.get(row.id) || 0)}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('directDeposit', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('subsidyBarangay', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('grantSpecific', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('grantNonSpecific', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('refundAdvance', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{editable('others', true, 'right')}</td>
                </tr>
              );
            })}
            <tr className="font-bold">
              <td colSpan={4} className="border border-black px-1 py-1 text-right">Totals for the quarter</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.receipt || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.deposit || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.directDeposit || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.subsidyBarangay || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.grantSpecific || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.grantNonSpecific || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.refundAdvance || 0)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.others || 0)}</td>
            </tr>
            <tr className="font-bold italic">
              <td colSpan={4} className="border border-black px-1 py-1 text-right">Balance carried forward</td>
              <td colSpan={2} className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(runningBalance || snapshot.rcrdOpening)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.directDeposit || 0)}</td>
              <td colSpan={3} className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.subsidyBarangay + totals.grantSpecific + totals.grantNonSpecific)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.refundAdvance)}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(totals.others)}</td>
            </tr>
          </tbody>
        </table>
        <div className="mt-2 border border-black px-2 py-2 text-[7px]">
          <p>Prepared and Certified Correct by:</p>
          <div className="mt-4 flex justify-around text-center">
            <div className="min-w-[110px]"><div className="border-b border-black px-2 pb-0.5 font-semibold">{snapshot.common.preparedBy || snapshot.common.treasurer}</div><p>Signature over Printed Name</p><p>SK Treasurer</p></div>
            <div className="min-w-[100px]"><div className="border-b border-black px-2 pb-0.5">{displayDate(snapshot.common.preparedDate)}</div><p>Date</p></div>
          </div>
        </div>
      </div>
    );
  };

  const renderRcbDocument = (snapshot: CashBankSnapshot, readOnly: boolean) => {
    const entries = snapshot.rcbRows;
    let runningBalance = snapshot.rcbOpening;
    const balancesById = new Map<string, number>();
    entries.forEach((row) => { runningBalance += toNumber(row.deposit) - toNumber(row.withdrawal); balancesById.set(row.id, runningBalance); });
    const finalBalance = runningBalance;
    const filledRows = entries.filter((row) => row.date || row.reference || row.payee || row.particulars || RCB_COLUMNS.some((col) => col.numeric && toNumber(row[col.key]) !== 0));
    const displayRows = readOnly ? (filledRows.length ? filledRows : entries) : entries;
    const total = (key: keyof RcbEntry) => moneySum(entries as unknown as Record<string, unknown>[], key);
    const expenseKeys = RCB_COLUMNS.filter((col) => !['date', 'reference', 'payee', 'particulars', 'deposit', 'withdrawal', 'balance'].includes(String(col.key)));
    return (
      <div className="cashbank-paper-content text-[6px] text-slate-950">
        {documentHeader(snapshot, titleForTab('rcb'))}
        <table className="mt-0 w-full table-fixed border-collapse border border-black text-[5.1px] leading-[1.05]">
          <colgroup>{RCB_COLUMNS.map((col) => <col key={col.key} style={{ width: col.width }} />)}</colgroup>
          <thead>
            <tr className="text-center">
              <th rowSpan={3} className="border border-black px-0.5 py-1">Date</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Reference</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Name of Payee</th>
              <th rowSpan={3} className="border border-black px-0.5 py-1">Particulars</th>
              <th colSpan={3} className="border border-black px-0.5 py-1">Cash in Bank</th>
              <th colSpan={16} className="border border-black px-0.5 py-1">BREAKDOWN OF WITHDRAWALS / PAYMENTS</th>
            </tr>
            <tr className="text-center">
              <th rowSpan={2} className="border border-black px-0.5 py-1">Deposit</th>
              <th rowSpan={2} className="border border-black px-0.5 py-1">Withdrawal</th>
              <th rowSpan={2} className="border border-black px-0.5 py-1">Balance</th>
              <th colSpan={8} className="border border-black px-0.5 py-1">Maintenance and Other Operating Expenses</th>
              <th colSpan={3} className="border border-black px-0.5 py-1">Capital Outlay</th>
              <th colSpan={2} className="border border-black px-0.5 py-1">Advances</th>
              <th rowSpan={2} className="border border-black px-0.5 py-1">Others</th>
              <th colSpan={2} className="border border-black px-0.5 py-1">Withholding Tax</th>
            </tr>
            <tr className="text-center">
              {expenseKeys.filter((col) => col.key !== 'others').map((col) => (
                <th key={col.key} className="border border-black px-0.5 py-1">{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="italic">
              <td colSpan={4} className="border border-black px-1 py-1 text-right">Totals/Balance brought forward</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">—</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(snapshot.rcbOpening)}</td>
              {expenseKeys.map((col) => <td key={col.key} className="border border-black px-0.5 py-1 text-right">—</td>)}
            </tr>
            {displayRows.map((row) => {
              const valueFor = (key: keyof RcbEntry, numeric = false, align: 'left' | 'right' | 'center' = 'left') => cellInput(
                row[key] as string | number,
                (next) => updateRcb(row.id, key, (numeric ? toNumber(next) : next) as RcbEntry[typeof key]),
                readOnly,
                numeric,
                align
              );
              return (
                <tr key={row.id}>
                  <td className="border border-black px-0.5 py-1">{valueFor('date')}</td>
                  <td className="border border-black px-0.5 py-1">{valueFor('reference')}</td>
                  <td className="border border-black px-0.5 py-1">{valueFor('payee')}</td>
                  <td className="border border-black px-0.5 py-1">{valueFor('particulars')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{valueFor('deposit', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{valueFor('withdrawal', true, 'right')}</td>
                  <td className="border border-black px-0.5 py-1 text-right">{formatMoney(balancesById.get(row.id) || 0)}</td>
                  {expenseKeys.map((col) => <td key={col.key} className="border border-black px-0.5 py-1 text-right">{valueFor(col.key, true, 'right')}</td>)}
                </tr>
              );
            })}
            <tr className="font-bold">
              <td colSpan={4} className="border border-black px-1 py-1 text-right">Totals for the quarter</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(total('deposit'))}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(total('withdrawal'))}</td>
              <td className="border border-black px-0.5 py-1 text-right">{formatMoney(finalBalance)}</td>
              {expenseKeys.map((col) => <td key={col.key} className="border border-black px-0.5 py-1 text-right">{formatMoney(total(col.key))}</td>)}
            </tr>
            <tr className="font-bold italic">
              <td colSpan={4} className="border border-black px-1 py-1 text-right">Balance carried forward</td>
              <td colSpan={3} className="border border-black px-0.5 py-1 text-right">{formatMoney(finalBalance)}</td>
              {expenseKeys.map((col) => <td key={col.key} className="border border-black px-0.5 py-1 text-right">{formatMoney(total(col.key))}</td>)}
            </tr>
          </tbody>
        </table>
        <div className="mt-2 border border-black px-2 py-2 text-[7px]">
          <p>Prepared and Certified Correct by:</p>
          <div className="mt-4 flex justify-around text-center">
            <div className="min-w-[110px]"><div className="border-b border-black px-2 pb-0.5 font-semibold">{snapshot.common.preparedBy || snapshot.common.treasurer}</div><p>Signature over Printed Name</p><p>SK Treasurer</p></div>
            <div className="min-w-[100px]"><div className="border-b border-black px-2 pb-0.5">{displayDate(snapshot.common.preparedDate)}</div><p>Date</p></div>
          </div>
        </div>
      </div>
    );
  };

  const renderChecksDocument = (snapshot: CashBankSnapshot, readOnly: boolean) => (
    <div className="cashbank-paper-content text-[8px] text-slate-950">
      <div className="relative mb-4 text-center">
        <span className="absolute right-2 top-0 text-[9px]">Annex 11</span>
        <h1 className="pt-3 text-center text-[14px] font-bold">LOGBOOK OF CHECKS ISSUED AND CANCELLED</h1>
        <p className="mt-1 text-[10px]">{snapshot.common.barangay}, {snapshot.common.city}, {snapshot.common.province}</p>
      </div>
      <table className="mt-4 w-full table-fixed border-collapse border border-black text-[8px] leading-tight">
        <colgroup>
          {['10%', '11%', '19%', '10%', '8%', '8%', '12%', '12%', '10%'].map((width, index) => <col key={index} style={{ width }} />)}
        </colgroup>
        <thead>
          <tr className="text-center">
            <th className="border border-black px-1 py-2">Date</th>
            <th className="border border-black px-1 py-2">Check No.</th>
            <th className="border border-black px-1 py-2">Particulars</th>
            <th className="border border-black px-1 py-2">Name of Payee</th>
            <th className="border border-black px-1 py-2">Signature of Payee</th>
            <th className="border border-black px-1 py-2">Date Received</th>
            <th className="border border-black px-1 py-2">Name of Authorized Representative</th>
            <th className="border border-black px-1 py-2">Signature of Authorized Representative</th>
            <th className="border border-black px-1 py-2">Date Received</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.checkRows.map((row) => {
            const value = (key: keyof CheckEntry) => cellInput(row[key], (next) => updateCheck(row.id, key, next), readOnly, false, 'left');
            return (
              <tr key={row.id} className="h-[21px]">
                <td className="border border-black px-1 py-1">{value('date')}</td>
                <td className="border border-black px-1 py-1">{value('checkNumber')}</td>
                <td className="border border-black px-1 py-1">{value('particulars')}</td>
                <td className="border border-black px-1 py-1">{value('payee')}</td>
                <td className="border border-black px-1 py-1">{value('payeeSignature')}</td>
                <td className="border border-black px-1 py-1">{value('payeeDateReceived')}</td>
                <td className="border border-black px-1 py-1">{value('representative')}</td>
                <td className="border border-black px-1 py-1">{value('representativeSignature')}</td>
                <td className="border border-black px-1 py-1">{value('representativeDateReceived')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const renderReconDocument = (snapshot: CashBankSnapshot, readOnly: boolean) => {
    const reconFields = snapshot.recon;
    const adjustedRcb = reconFields.unadjustedRcb + snapshot.reconRows.reduce((sum, row) => sum + (row.kind === 'entry' ? toNumber(row.rcb) : 0), 0);
    const adjustedBank = reconFields.unadjustedBank + snapshot.reconRows.reduce((sum, row) => sum + (row.kind === 'entry' ? toNumber(row.bank) : 0), 0);
    return (
      <div className="cashbank-paper-content mx-auto max-w-[175mm] text-[9px] text-slate-950">
        <h1 className="text-center text-[15px] font-bold">BANK RECONCILIATION STATEMENT</h1>
        <div className="mb-3 mt-1 text-center text-[10px]">
          For the month of <span className="inline-block min-w-[110px] border-b border-black px-2">{displayDate(reconFields.statementMonth)}</span>
          <p className="text-[8px] italic">(Date)</p>
        </div>
        <table className="w-full border-collapse border border-black text-[9px] leading-tight">
          <tbody>
            <tr>
              <td className="w-1/2 border border-black px-2 py-1">SK of Barangay: {snapshot.common.barangay}</td>
              <td className="w-1/2 border border-black px-2 py-1">Bank Name: {readOnly ? reconFields.bankName : cellInput(reconFields.bankName, (next) => setReconField('bankName', next), false)}</td>
            </tr>
            <tr>
              <td className="border border-black px-2 py-1">City/Municipality: {snapshot.common.city}</td>
              <td className="border border-black px-2 py-1">Branch: {readOnly ? reconFields.branch : cellInput(reconFields.branch, (next) => setReconField('branch', next), false)}</td>
            </tr>
            <tr>
              <td className="border border-black px-2 py-1">Province: {snapshot.common.province}</td>
              <td className="border border-black px-2 py-1">Current Account No.: {readOnly ? reconFields.accountNumber : cellInput(reconFields.accountNumber, (next) => setReconField('accountNumber', next), false)}</td>
            </tr>
            <tr className="text-center font-semibold">
              <td className="border border-black px-2 py-1">Particulars</td>
              <td className="border border-black p-0">
                <table className="w-full table-fixed border-collapse">
                  <tbody><tr><td className="w-[25%] border-r border-black px-1 py-1">RCB</td><td className="w-[25%] border-r border-black px-1 py-1">Bank</td><td className="px-1 py-1">Explanatory Comment</td></tr></tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
        <table className="w-full table-fixed border-collapse border-x border-b border-black text-[9px] leading-tight">
          <colgroup><col style={{ width: '42%' }} /><col style={{ width: '16%' }} /><col style={{ width: '16%' }} /><col style={{ width: '26%' }} /></colgroup>
          <tbody>
            <tr>
              <td className="border border-black px-2 py-1 font-medium">Unadjusted Balances</td>
              <td className="border border-black px-2 py-1 text-center">{readOnly ? formatMoney(reconFields.unadjustedRcb) : cellInput(reconFields.unadjustedRcb, (next) => setReconField('unadjustedRcb', toNumber(next)), false, true, 'right')}</td>
              <td className="border border-black px-2 py-1 text-center">{readOnly ? formatMoney(reconFields.unadjustedBank) : cellInput(reconFields.unadjustedBank, (next) => setReconField('unadjustedBank', toNumber(next)), false, true, 'right')}</td>
              <td className="border border-black px-2 py-1" />
            </tr>
            <tr><td colSpan={4} className="border border-black px-2 py-1 font-semibold">Reconciling Items:</td></tr>
            {snapshot.reconRows.map((row) => row.kind === 'section' ? (
              <tr key={row.id}><td colSpan={4} className="border border-black px-2 py-1 font-medium">{row.label}</td></tr>
            ) : (
              <tr key={row.id}>
                <td className="border border-black px-2 py-1 pl-5">{readOnly ? row.label : cellInput(row.label, (next) => updateReconLine(row.id, 'label', next), false)}</td>
                <td className="border border-black px-2 py-1 text-center">{readOnly ? (row.rcb ? formatMoney(row.rcb) : '') : cellInput(row.rcb, (next) => updateReconLine(row.id, 'rcb', toNumber(next)), false, true, 'right')}</td>
                <td className="border border-black px-2 py-1 text-center">{readOnly ? (row.bank ? formatMoney(row.bank) : '') : cellInput(row.bank, (next) => updateReconLine(row.id, 'bank', toNumber(next)), false, true, 'right')}</td>
                <td className="border border-black px-2 py-1">{readOnly ? row.comment : cellInput(row.comment, (next) => updateReconLine(row.id, 'comment', next), false)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td className="border border-black px-2 py-1">Adjusted Balances</td>
              <td className="border border-black px-2 py-1 text-center">{formatMoney(adjustedRcb)}</td>
              <td className="border border-black px-2 py-1 text-center">{formatMoney(adjustedBank)}</td>
              <td className="border border-black px-2 py-1" />
            </tr>
          </tbody>
        </table>
        <div className="mt-3 grid grid-cols-2 gap-8 border border-black px-3 py-3 text-center">
          <div>
            <p className="mb-5 text-left">Prepared and Certified Correct by:</p>
            <p className="mx-auto max-w-[165px] border-b border-black pb-1 font-semibold">{snapshot.common.preparedBy}</p>
            <p>Signature over Printed Name</p><p>of SK Treasurer</p>
            <p className="mx-auto mt-2 max-w-[110px] border-b border-black pb-1">{displayDate(snapshot.common.preparedDate)}</p><p>Date</p>
          </div>
          <div>
            <p className="mb-5 text-left">Approved by:</p>
            <p className="mx-auto max-w-[165px] border-b border-black pb-1 font-semibold">{reconFields.approvedBy}</p>
            <p>Signature over Printed Name</p><p>of SK Chairperson</p>
            <p className="mx-auto mt-2 max-w-[110px] border-b border-black pb-1">{displayDate(reconFields.approvedDate)}</p><p>Date</p>
          </div>
        </div>
      </div>
    );
  };

  const renderDocument = (snapshot: CashBankSnapshot, readOnly = false) => {
    if (snapshot.tab === 'rcrd') return renderRcrdDocument(snapshot, readOnly);
    if (snapshot.tab === 'rcb') return renderRcbDocument(snapshot, readOnly);
    if (snapshot.tab === 'checks') return renderChecksDocument(snapshot, readOnly);
    return renderReconDocument(snapshot, readOnly);
  };

  const filteredSavedRecords = savedRecords.filter((record) =>
    `${record.finalId} ${record.title} ${record.dateText}`.toLowerCase().includes(databaseSearch.toLowerCase())
  );

  return (
    <div className="space-y-4 cashbank-page">
      <style>{`
        @media print {
          @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
          body { background: #fff !important; }
          .no-print, .cashbank-page > .no-print { display: none !important; }
          .cashbank-preview-shell { border: 0 !important; padding: 0 !important; background: #fff !important; overflow: visible !important; }
          .cashbank-print-sheet { box-shadow: none !important; border: 0 !important; margin: 0 !important; transform: none !important; position: static !important; }
          .cashbank-preview-scroll { overflow: visible !important; }
          .cashbank-preview-scroll > div > div { width: auto !important; height: auto !important; }
          .cashbank-preview-scroll { cursor: auto !important; }
          .cashbank-preview-stage { width: 100% !important; min-width: 0 !important; padding-left: 0 !important; padding-right: 0 !important; }
          body.cashbank-print-saved .cashbank-page > :not(.cashbank-view-dialog) { display: none !important; }
          body.cashbank-print-saved .cashbank-view-dialog { position: static !important; display: block !important; padding: 0 !important; background: #fff !important; }
          body.cashbank-print-saved .cashbank-view-dialog > div { max-width: none !important; max-height: none !important; overflow: visible !important; padding: 0 !important; box-shadow: none !important; background: #fff !important; }
          body.cashbank-print-saved .cashbank-view-actions { display: none !important; }
          body.cashbank-print-saved .cashbank-view-scroll { overflow: visible !important; padding: 0 !important; background: #fff !important; }
          body.cashbank-print-saved .cashbank-view-sheet { box-shadow: none !important; margin: 0 !important; }
          body.cashbank-print-saved .cashbank-page { display: block !important; }
        }
      `}</style>

      <div className="no-print">
        <PageTabs
        tabs={TABS.map(({ key, label }) => ({ key, label }))}
        activeTab={activeTab}
        onChange={(nextTab) => {
          if (nextTab !== activeTab) setCurrentId(makeId());
          setActiveTab(nextTab);
          const nextOrientation: PaperOrientation = nextTab === 'recon' ? 'portrait' : 'landscape';
          setOrientation(nextOrientation);
          setPaperSize('a4');
          setPreviewZoom(100);
        }}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
        <section className="no-print space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-2xs xl:col-span-4">
          <div className="border-b border-slate-200 pb-3">
            <h2 className="text-sm font-semibold text-slate-900">{currentTabMeta.label}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{currentTabMeta.description}</p>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-[11px] text-slate-600">Press <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono">Enter</kbd> to save</span>
            <div className="flex gap-1.5">
              <button type="button" onClick={resetCurrentForm} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">New</button>
              <button type="button" onClick={requestSave} disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"><Save className="h-3.5 w-3.5" />Save</button>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-800">Form Information</h3>
            {activeTab !== 'recon' && activeTab !== 'checks' && (
              <>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Sheet No. · Automatically Generated</span>
                  <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{common.sheetNumber}</span>
                </div>
                <label className="block text-xs font-medium text-slate-700">Fund<input value={common.fund} onChange={(event) => setCommonField('fund', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                <label className="block text-xs font-medium text-slate-700">Opening Balance<CashBankNumericInput value={activeTab === 'rcrd' ? rcrdOpening : rcbOpening} onChange={(next) => activeTab === 'rcrd' ? setRcrdOpening(next) : setRcbOpening(next)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
              </>
            )}
            {activeTab === 'checks' && (
              <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form Reference · Check Logbook</span>
                <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{currentFinalId}</span>
              </div>
            )}
            {activeTab === 'recon' && (
              <>
                <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form Reference · Statement Month</span>
                  <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{currentFinalId}</span>
                </div>
                <label className="block text-xs font-medium text-slate-700">Statement Month<input type="date" value={recon.statementMonth} onChange={(event) => setReconField('statementMonth', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                <label className="block text-xs font-medium text-slate-700">Bank Name<input value={recon.bankName} onChange={(event) => setReconField('bankName', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                <label className="block text-xs font-medium text-slate-700">Branch<input value={recon.branch} onChange={(event) => setReconField('branch', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                <label className="block text-xs font-medium text-slate-700">Current Account No.<input value={recon.accountNumber} onChange={(event) => setReconField('accountNumber', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs font-medium text-slate-700">Unadjusted RCB<CashBankNumericInput value={recon.unadjustedRcb} onChange={(next) => setReconField('unadjustedRcb', next)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                  <label className="block text-xs font-medium text-slate-700">Unadjusted Bank<CashBankNumericInput value={recon.unadjustedBank} onChange={(next) => setReconField('unadjustedBank', next)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">SK Chairperson / Approved By</span>
                  <span className="mt-0.5 block text-xs font-semibold text-slate-800">{recon.approvedBy}</span>
                </div>
                <label className="block text-xs font-medium text-slate-700">Approved Date<input type="date" value={recon.approvedDate} onChange={(event) => setReconField('approvedDate', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
              </>
            )}
            {activeTab === 'checks' && (
              <p className="rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">Enter the check information directly in the logbook preview. Each completed row is saved as an individual check record.</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs font-medium text-slate-700">Barangay<input value={common.barangay} onChange={(event) => setCommonField('barangay', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs font-normal" /></label>
              <label className="block text-xs font-medium text-slate-700">City/Municipality<input value={common.city} onChange={(event) => setCommonField('city', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-xs font-normal" /></label>
            </div>
            <label className="block text-xs font-medium text-slate-700">Province<input value={common.province} onChange={(event) => setCommonField('province', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
            {activeTab !== 'checks' && (
              <>
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">SK Treasurer / Prepared By</span>
                  <span className="mt-0.5 block text-xs font-semibold text-slate-800">{common.treasurer || common.preparedBy}</span>
                </div>
                <label className="block text-xs font-medium text-slate-700">Prepared Date<input type="date" value={common.preparedDate} onChange={(event) => setCommonField('preparedDate', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 text-xs font-normal" /></label>
              </>
            )}
          </div>

          <div className="border-t border-slate-200 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-800">Row Controls</h3>
              <button type="button" onClick={() => {
                if (activeTab === 'rcrd') setRcrdRows((previous) => [...previous, makeRcrdEntry()]);
                else if (activeTab === 'rcb') setRcbRows((previous) => [...previous, makeRcbEntry()]);
                else if (activeTab === 'checks') setCheckRows((previous) => [...previous, makeCheckEntry()]);
                else setReconRows((previous) => [...previous, { id: makeId(), label: 'Other Reconciling Item', kind: 'entry', rcb: 0, bank: 0, comment: '' }]);
              }} className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-[11px] font-semibold text-sky-800 hover:bg-sky-100"><Plus className="h-3.5 w-3.5" />Add Row</button>
            </div>
            <p className="text-[11px] text-slate-500">Use the Add Row button to extend the form. Remove blank rows from the preview using the row delete control below.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {activeTab === 'rcrd' && <button type="button" onClick={() => setRcrdRows((previous) => previous.length > 1 ? previous.slice(0, -1) : previous)} className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50">Remove Last Row</button>}
              {activeTab === 'rcb' && <button type="button" onClick={() => setRcbRows((previous) => previous.length > 1 ? previous.slice(0, -1) : previous)} className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50">Remove Last Row</button>}
              {activeTab === 'checks' && <button type="button" onClick={() => setCheckRows((previous) => previous.length > 1 ? previous.slice(0, -1) : previous)} className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50">Remove Last Row</button>}
              {activeTab === 'recon' && <button type="button" onClick={() => setReconRows((previous) => previous.length ? previous.slice(0, -1) : previous)} className="rounded border border-rose-200 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50">Remove Last Row</button>}
            </div>
          </div>

          {(activeTab === 'rcrd' || activeTab === 'rcb') && (
            <section className="space-y-2 border-t border-slate-200 pt-3">
              <div>
                <h3 className="text-xs font-semibold text-slate-800">Itemized Row Inputs</h3>
                <p className="mt-0.5 text-[10px] text-slate-500">Enter each transaction here. The paper preview updates automatically.</p>
              </div>
              {(activeTab === 'rcrd' ? rcrdRows : rcbRows).map((row, index) => (
                <details key={row.id} open={index === 0} className="rounded-lg border border-slate-200 bg-white">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[11px] font-semibold text-slate-700">
                    <span>Row {index + 1} · {String((row as RcrdEntry | RcbEntry).particulars || (activeTab === 'rcrd' ? (row as RcrdEntry).payor : (row as RcbEntry).payee) || 'New transaction')}</span>
                    <span className="text-sky-700">Edit fields</span>
                  </summary>
                  <div className="grid grid-cols-1 gap-2 border-t border-slate-100 p-3 sm:grid-cols-2">
                    {(activeTab === 'rcrd' ? RCRD_EDIT_FIELDS : RCB_EDIT_FIELDS).map((field) => {
                      const value = (row as unknown as Record<string, unknown>)[String(field.key)];
                      const update = (next: string | number) => {
                        if (activeTab === 'rcrd') updateRcrd(row.id, field.key as keyof RcrdEntry, next as never);
                        else updateRcb(row.id, field.key as keyof RcbEntry, next as never);
                      };
                      return (
                        <label key={String(field.key)} className="block min-w-0 text-[10px] font-medium text-slate-600">
                          {field.label}
                          {field.numeric ? (
                            <CashBankNumericInput value={toNumber(value)} onChange={update} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" />
                          ) : (
                            <input value={String(value ?? '')} onChange={(event) => update(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" />
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex justify-end border-t border-slate-100 px-3 py-2">
                    <button type="button" onClick={() => activeTab === 'rcrd' ? setRcrdRows((rows) => rows.length > 1 ? rows.filter((item) => item.id !== row.id) : rows) : setRcbRows((rows) => rows.length > 1 ? rows.filter((item) => item.id !== row.id) : rows)} className="rounded border border-rose-200 px-2 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-50">Remove this row</button>
                  </div>
                </details>
              ))}
            </section>
          )}

          {activeTab === 'checks' && (
            <section className="space-y-2 border-t border-slate-200 pt-3">
              <div><h3 className="text-xs font-semibold text-slate-800">Itemized Check Entries</h3><p className="mt-0.5 text-[10px] text-slate-500">Add or edit each check record below. Payee and authorized representative are information columns in the official logbook.</p></div>
              {checkRows.map((row, index) => (
                <details key={row.id} open={index === 0} className="rounded-lg border border-slate-200 bg-white">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-[11px] font-semibold text-slate-700"><span>Check Row {index + 1} · {row.checkNumber || 'Unnumbered'}</span><span className="text-sky-700">Edit fields</span></summary>
                  <div className="grid grid-cols-1 gap-2 border-t border-slate-100 p-3 sm:grid-cols-2">
                    {CHECK_EDIT_FIELDS.map((field) => (
                      <label key={String(field.key)} className="block min-w-0 text-[10px] font-medium text-slate-600">{field.label}<input value={String(row[field.key] ?? '')} onChange={(event) => updateCheck(row.id, field.key, event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" /></label>
                    ))}
                  </div>
                  <div className="flex justify-end border-t border-slate-100 px-3 py-2"><button type="button" onClick={() => setCheckRows((rows) => rows.length > 1 ? rows.filter((item) => item.id !== row.id) : rows)} className="rounded border border-rose-200 px-2 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-50">Remove this row</button></div>
                </details>
              ))}
            </section>
          )}

          {activeTab === 'recon' && (
            <section className="space-y-2 border-t border-slate-200 pt-3">
              <div><h3 className="text-xs font-semibold text-slate-800">Reconciling Item Inputs</h3><p className="mt-0.5 text-[10px] text-slate-500">Enter RCB amount, bank amount and explanatory comments for each item.</p></div>
              {reconRows.filter((row) => row.kind !== 'section').map((row, index) => (
                <div key={row.id} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2">
                  <label className="text-[10px] font-medium text-slate-600 sm:col-span-2">Particulars<input value={row.label} onChange={(event) => updateReconLine(row.id, 'label', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" /></label>
                  <label className="text-[10px] font-medium text-slate-600">RCB Amount<CashBankNumericInput value={row.rcb} onChange={(value) => updateReconLine(row.id, 'rcb', value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" /></label>
                  <label className="text-[10px] font-medium text-slate-600">Bank Amount<CashBankNumericInput value={row.bank} onChange={(value) => updateReconLine(row.id, 'bank', value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" /></label>
                  <label className="text-[10px] font-medium text-slate-600 sm:col-span-2">Explanatory Comment<input value={row.comment} onChange={(event) => updateReconLine(row.id, 'comment', event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs font-normal text-slate-900" /></label>
                </div>
              ))}
            </section>
          )}

        </section>

        <section className="min-w-0 space-y-4 xl:col-span-8">
          <div className="no-print flex flex-wrap items-center justify-end gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-2xs">
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
              Paper Size
              <select value={paperSize} onChange={(event) => { setPaperSize(event.target.value as PaperSizeKey); setPreviewZoom(100); }} className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700">
                {Object.entries(PAPER_DIMENSIONS).map(([key, spec]) => <option key={key} value={key}>{spec.label}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
              Orientation
              <select value={orientation} onChange={(event) => { setOrientation(event.target.value as PaperOrientation); setPreviewZoom(100); }} className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700">
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <button type="button" onClick={() => void handleDownloadPdf()} disabled={isDownloadingPdf} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-60"><Download className="h-3.5 w-3.5" />{isDownloadingPdf ? 'Downloading...' : 'Download'}</button>
            <button type="button" onClick={handlePrint} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800"><Printer className="h-3.5 w-3.5" />Print</button>
            <button type="button" onClick={() => void openDatabase()} className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-100"><Database className="h-3.5 w-3.5" />Database</button>
            <div className="inline-flex items-center gap-1.5">
              <span className="px-1 text-xs font-medium text-slate-600">Zoom</span>
              <button type="button" onClick={() => setPreviewZoom((previous) => Math.max(50, previous - 10))} disabled={previewZoom <= 50} className="w-9 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs disabled:opacity-40">−</button>
              <button type="button" onClick={() => setPreviewZoom(100)} className="w-12 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">{previewZoom}%</button>
              <button type="button" onClick={() => setPreviewZoom((previous) => Math.min(200, previous + 10))} disabled={previewZoom >= 200} className="w-9 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs disabled:opacity-40">+</button>
            </div>
          </div>

          <div
            ref={previewViewportRef}
            {...panHandlers}
            className={`cashbank-preview-shell cashbank-preview-scroll min-w-0 overflow-auto rounded-xl border border-slate-300/80 bg-slate-200/80 p-4 print:overflow-visible print:border-0 print:bg-white print:p-0 ${isPreviewDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
            style={{ touchAction: 'none' }}
          >
            <div
              className="cashbank-preview-stage flex min-w-full"
              style={{
                width: previewZoom > 100 ? 'max-content' : '100%',
                minHeight: `${scaledPageHeightPx}px`,
                paddingLeft: previewZoom > 100 ? `${previewViewportWidth / 2}px` : 0,
                paddingRight: previewZoom > 100 ? `${previewViewportWidth / 2}px` : 0,
              }}
            >
              <div className="relative shrink-0" style={{ width: `${scaledPageWidthPx}px`, height: `${scaledPageHeightPx}px` }}>
                <div
                  ref={sheetRef}
                  className="cashbank-print-sheet absolute left-0 top-0 shrink-0 bg-white text-black shadow-lg ring-1 ring-slate-900/10 print:shadow-none print:ring-0"
                  style={{
                    width: `${pageWidthMm}mm`,
                    minHeight: `${pageHeightMm}mm`,
                    padding: `${activeTab === 'recon' ? 15 : 8}mm`,
                    fontFamily: 'Arial, Helvetica, sans-serif',
                    transform: `scale(${previewScale})`,
                    transformOrigin: 'top left',
                  }}
                >
                  {renderDocument(currentSnapshot, false)}
                </div>
              </div>
            </div>
          </div>
          <div className="no-print flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>{currentTabMeta.description}</span>
            <span>Reference: <strong className="font-mono text-slate-700">{currentFinalId}</strong></span>
          </div>
        </section>
      </div>

      <SaveConfirmModal
        open={saveConfirmOpen}
        docLabel={currentTabMeta.label}
        recordTitle={currentRecordTitle}
        finalIdPreview={currentFinalId}
        isSaving={isSaving}
        onCancel={() => setSaveConfirmOpen(false)}
        onConfirm={() => void saveCurrentRecord()}
      />
      <StatusDialog dialog={statusDialog} onClose={closeStatusDialog} />

      {isDatabaseDialogOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="flex max-h-[88vh] w-full max-w-5xl flex-col space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2"><Database className="h-4 w-4 text-sky-700" /><div><h3 className="text-sm font-semibold text-slate-900">{currentTabMeta.label} Database ({savedRecords.length})</h3><p className="text-[11px] text-slate-500">Saved records from Supabase</p></div></div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void loadDatabaseRecords()} disabled={isLoadingDatabase} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${isLoadingDatabase ? 'animate-spin' : ''}`} />Refresh</button>
                <button type="button" onClick={() => setIsDatabaseDialogOpen(false)} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <input value={databaseSearch} onChange={(event) => setDatabaseSearch(event.target.value)} placeholder="Search by reference, title or date..." className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs outline-none focus:border-sky-500" />
            <div className="min-h-0 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[720px] border-collapse text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-700"><tr><th className="px-3 py-2 text-left">Reference / ID</th><th className="px-3 py-2 text-left">Title</th><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
                <tbody className="divide-y divide-slate-200">
                  {isLoadingDatabase ? <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading records...</td></tr> : filteredSavedRecords.length === 0 ? <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-500">No saved records found for this module.</td></tr> : filteredSavedRecords.map((record) => (
                    <tr key={record.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-[10px] font-semibold text-sky-900">{record.finalId}<span className="mt-0.5 block font-normal text-slate-400">{record.id}</span></td>
                      <td className="px-3 py-2 font-medium text-slate-800">{record.title}</td>
                      <td className="px-3 py-2 text-slate-600">{record.dateText || '—'}</td>
                      <td className="px-3 py-2 text-right"><div className="inline-flex items-center gap-1.5">
                        <button type="button" onClick={() => setViewingRecord(record)} className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"><Eye className="h-3 w-3" />View</button>
                        <button type="button" onClick={() => loadSavedRecordIntoEditor(record)} className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1 text-[11px] text-sky-800 hover:bg-sky-100"><Pencil className="h-3 w-3" />Load/Edit</button>
                        <button type="button" onClick={() => setDeletingRecord(record)} className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-100"><Trash2 className="h-3 w-3" />Delete</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {viewingRecord && (
        <div role="dialog" aria-modal="true" className="cashbank-view-dialog fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3">
          <div className="flex max-h-[94vh] w-full max-w-6xl flex-col space-y-3 rounded-xl bg-slate-100 p-4 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
              <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-sky-700" /><div><h3 className="text-sm font-semibold">Document Preview — {viewingRecord.finalId}</h3><p className="text-[10px] text-slate-500">Database ID: {viewingRecord.id}</p></div></div>
              <div className="cashbank-view-actions flex gap-2"><button type="button" onClick={handlePrintSavedRecord} className="inline-flex items-center gap-1 rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800"><Printer className="h-3.5 w-3.5" />Print</button><button type="button" onClick={() => { void navigator.clipboard?.writeText(viewingRecord.id); showStatus('success', 'ID Copied', 'The database record ID was copied.'); }} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Copy className="h-3.5 w-3.5" />Copy ID</button><button type="button" onClick={() => setViewingRecord(null)} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200"><X className="h-4 w-4" /></button></div>
            </div>
            <div {...panHandlers} className={`cashbank-view-scroll overflow-auto rounded-lg bg-slate-200 p-3 ${isPreviewDragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
              {(() => {
                const savedSnapshot = makeSnapshotFromSaved(viewingRecord);
                const savedLandscape = savedSnapshot.tab !== 'recon';
                const savedWidth = savedLandscape ? 297 : 210;
                const savedHeight = savedLandscape ? 210 : 297;
                return (
                  <div className="cashbank-view-sheet mx-auto bg-white p-3 shadow-md" style={{ width: `${savedWidth}mm`, minHeight: `${savedHeight}mm` }}>
                    {renderDocument(savedSnapshot, true)}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {deletingRecord && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-rose-600" /><h3 className="text-sm font-semibold text-slate-900">Delete Record?</h3></div>
            <p className="text-xs leading-relaxed text-slate-600">Delete <strong className="text-slate-900">{deletingRecord.finalId} — {deletingRecord.title}</strong> from the database? This action cannot be undone.</p>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-3"><button type="button" onClick={() => setDeletingRecord(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">Cancel</button><button type="button" onClick={() => void deleteSavedRecord()} className="rounded-md bg-rose-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-800">Delete</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

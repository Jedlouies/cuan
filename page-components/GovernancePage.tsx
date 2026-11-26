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
  Play,
  Square,
  RotateCcw,
  Loader2,
  UserPlus,
} from 'lucide-react';
import { PageTabs } from '../../components/ui/PageTabs';
import { SkBannerHeader } from '../../components/ui/SkBannerHeader';
import { SaveConfirmModal } from '../../components/ui/SaveConfirmModal';
import {
  StatusDialog,
  StatusDialogState,
  INITIAL_STATUS_DIALOG,
} from '../../components/ui/StatusDialog';
import { useSkSystem } from '../../hooks/useSkSystem';
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

type GovernanceTabKey = 'request-letter' | 'minutes' | 'resolutions';
type PaperSizeKey = 'a4' | 'letter' | 'legal';
type PaperOrientation = 'portrait' | 'landscape';
type GovernanceTableName =
  | 'governance_request_letters'
  | 'governance_minutes'
  | 'governance_resolutions';
type ResolutionStage = 'proposal' | 'final';

interface TimedNoteEntry {
  id: string;
  elapsedLabel: string;
  recordedAt: string;
  text: string;
}

interface LetterSignatory {
  id: string;
  name: string;
  role: string;
}

interface ResolutionPresentEntry {
  roleLabel: string;
  name: string;
  designation: string;
}

interface IntroducerEntry {
  name: string;
  role: string;
}

interface GovernancePayload {
  activeTab: GovernanceTabKey;
  paperSize?: PaperSizeKey;
  orientation?: PaperOrientation;
  docRefNo: string;
  // Request Letter
  letterDate: string;
  recipientName: string;
  recipientOffice: string;
  letterSubject: string;
  letterBody: string;
  signatoryName: string;
  signatoryRole: string;
  signatories: LetterSignatory[];
  // Minutes of Meeting
  sessionNo: string;
  sessionType: 'Regular Session' | 'Special Session';
  sessionDate: string;
  sessionTime: string;
  venue: string;
  presidingOfficer: string;
  skSecretary: string;
  presentMembers: string;
  absentMembers: string;
  agendaItems: string[];
  proceedingsNotes: string;
  timedNotes: TimedNoteEntry[];
  recordingDurationSec: number;
  // Resolutions (Proposal & Final)
  resolutionStage: ResolutionStage;
  resolutionNo: string;
  resolutionTitle: string;
  sessionExcerptText: string;
  resolutionPresentEntries: ResolutionPresentEntry[];
  resolutionAbsentText: string;
  introducers: IntroducerEntry[];
  whereasClauses: string[];
  nowThereforeClause: string;
  resolutionDate: string;
  resolutionSignatoryName: string;
  resolutionSignatoryRole: string;
}

export interface GovernanceDbRecord {
  id: string;
  finalId: string;
  tableName: GovernanceTableName;
  docType: GovernanceTabKey;
  title: string;
  dateText: string;
  updatedAt: string;
  payload: GovernancePayload;
}

const FIXED_SK_CHAIRPERSON = 'HON. RANCE EMIL D. ACHACOSO';
const FIXED_SK_SECRETARY = 'SK SECRETARY';
const GOVERNANCE_AUTOSAVE_PREFIX = 'sk_governance_autosave_v5';
const TIMES_NEW_ROMAN_STYLE = {
  fontFamily: '"Times New Roman", Times, Georgia, serif',
} as const;

const DEFAULT_AGENDA_ITEMS = [
  'Call to Order and Roll Call',
  'Approval of Agenda',
  'Deliberation on Priority Youth Programs, Resolutions, and Budget Matters',
  'Adjournment',
];

const SK_MEMBER_OPTIONS = [
  'HON. RANCE EMIL D. ACHACOSO (SK Chairperson)',
  'HON. EFREN F. CORPUZ (SK Kagawad)',
  'HON. SHANNEN KATE M. RAMOS (SK Kagawad)',
  'HON. RUCHELLE KYLE B. BAAL (SK Kagawad)',
  'HON. DHAR KENZOE B. OBSIOMA (SK Kagawad)',
  'HON. ABIJAH MIGUEL C. PACANA (SK Kagawad)',
  'HON. JAN MACKENXIE B. NAVARRO (SK Treasurer)',
  'SK Secretary',
];

const RESOLUTION_ROSTER_PRESETS: {
  label: string;
  entry: ResolutionPresentEntry;
}[] = [
  {
    label: 'HON. RANCE EMIL D. ACHACOSO — SK Chairperson (Presiding Officer)',
    entry: {
      roleLabel: 'SK Chairperson',
      name: 'HON. RANCE EMIL D. ACHACOSO',
      designation: 'Presiding Officer',
    },
  },
  {
    label: 'HON. EFREN F. CORPUZ — SK Kagawad (Member)',
    entry: {
      roleLabel: 'SK Kagawad',
      name: 'HON. EFREN F. CORPUZ',
      designation: 'Member',
    },
  },
  {
    label: 'HON. SHANNEN KATE M. RAMOS — SK Kagawad (Member)',
    entry: {
      roleLabel: 'SK Kagawad',
      name: 'HON. SHANNEN KATE M. RAMOS',
      designation: 'Member',
    },
  },
  {
    label: 'HON. RUCHELLE KYLE B. BAAL — SK Kagawad (Member)',
    entry: {
      roleLabel: 'SK Kagawad',
      name: 'HON. RUCHELLE KYLE B. BAAL',
      designation: 'Member',
    },
  },
  {
    label: 'HON. DHAR KENZOE B. OBSIOMA — SK Kagawad (Member)',
    entry: {
      roleLabel: 'SK Kagawad',
      name: 'HON. DHAR KENZOE B. OBSIOMA',
      designation: 'Member',
    },
  },
  {
    label: 'HON. ABIJAH MIGUEL C. PACANA — SK Kagawad (Member)',
    entry: {
      roleLabel: 'SK Kagawad',
      name: 'HON. ABIJAH MIGUEL C. PACANA',
      designation: 'Member',
    },
  },
  {
    label: 'HON. JAN MACKENXIE B. NAVARRO — SK Treasurer (Member)',
    entry: {
      roleLabel: 'SK Treasurer',
      name: 'HON. JAN MACKENXIE B. NAVARRO',
      designation: 'Member',
    },
  },
];

const DEFAULT_RESOLUTION_PRESENT: ResolutionPresentEntry[] = [
  {
    roleLabel: 'SK Chairperson',
    name: 'HON. RANCE EMIL D. ACHACOSO',
    designation: 'Presiding Officer',
  },
  {
    roleLabel: 'SK Kagawad',
    name: 'HON. EFREN F. CORPUZ',
    designation: 'Member',
  },
  {
    roleLabel: 'SK Kagawad',
    name: 'HON. SHANNEN KATE M. RAMOS',
    designation: 'Member',
  },
  {
    roleLabel: 'SK Kagawad',
    name: 'HON. RUCHELLE KYLE B. BAAL',
    designation: 'Member',
  },
  {
    roleLabel: 'SK Kagawad',
    name: 'HON. DHAR KENZOE B. OBSIOMA',
    designation: 'Member',
  },
  {
    roleLabel: 'SK Kagawad',
    name: 'HON. ABIJAH MIGUEL C. PACANA',
    designation: 'Member',
  },
  {
    roleLabel: 'SK Treasurer',
    name: 'HON. JAN MACKENXIE B. NAVARRO',
    designation: 'Member',
  },
];

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
  key: GovernanceTabKey;
  label: string;
  description: string;
  tableName: GovernanceTableName;
}[] = [
  {
    key: 'request-letter',
    label: 'Request Letter',
    description:
      'Draft official SK request letters and endorsements using the SK header.',
    tableName: 'governance_request_letters',
  },
  {
    key: 'minutes',
    label: 'Minutes of Meeting',
    description:
      'Paper-formatted SK session minutes with automated session numbering, auto-numbered agenda, and timed note recording.',
    tableName: 'governance_minutes',
  },
  {
    key: 'resolutions',
    label: 'Resolutions',
    description:
      'Draft Proposal and Final SK resolutions using the uploaded SK resolution format.',
    tableName: 'governance_resolutions',
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

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(
      2,
      '0'
    )}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function splitAttendeeList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== 'none');
}

function appendAttendee(currentRaw: string, addition: string): string {
  const trimmed = addition.trim();
  if (!trimmed) return currentRaw;
  if (trimmed.toLowerCase() === 'none') return 'None';
  const existing = splitAttendeeList(currentRaw);
  if (existing.includes(trimmed)) return existing.join(', ');
  return [...existing, trimmed].join(', ');
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

function generateUniqueSessionNumber(existingNumbers: Iterable<string>): string {
  const used = new Set(
    Array.from(existingNumbers).map((s) => s.trim().toUpperCase())
  );
  const year = new Date().getFullYear();
  const prefix = `SK-MIN-${year}-`;

  let counter = 1;
  let candidate = `${prefix}${String(counter).padStart(3, '0')}`;
  while (used.has(candidate.toUpperCase())) {
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
      .replace(/^_+|_+$/g, '') || 'Governance_Document'
  );
}

function stripClausePrefix(text: string): string {
  return text
    .trim()
    .replace(/^(?:WHEREAS,?\s*|NOW,\s*THEREFORE,?\s*)/i, '')
    .trimStart();
}

function renderBoldLeadClause(text: string, automaticLead: string) {
  const body = stripClausePrefix(text);
  if (!body) return null;

  const originalLead = text.trim().match(
    /^(WHEREAS,?\s*|NOW,\s*THEREFORE,?\s*)/i
  )?.[1];

  return (
    <>
      <strong className="font-bold">{originalLead || automaticLead}</strong>
      <span>{body}</span>
    </>
  );
}

export function GovernancePage() {
  const { committee } = useSkSystem();

  // Multi-user draft isolation state
  const [currentUserId, setCurrentUserId] = useState<string>('anonymous');
  const [isUserResolved, setIsUserResolved] = useState<boolean>(false);
  const restoredForUserRef = useRef<string | null>(null);

  const [activeTab, setActiveTab] = useState<GovernanceTabKey>('request-letter');
  const [paperSize, setPaperSize] = useState<PaperSizeKey>('a4');
  const [orientation, setOrientation] = useState<PaperOrientation>('portrait');

  const [isSupabaseConnected, setIsSupabaseConnected] = useState<boolean>(false);
  const [isConnectingSupabase, setIsConnectingSupabase] = useState<boolean>(true);

  const [isDatabaseDialogOpen, setIsDatabaseDialogOpen] =
    useState<boolean>(false);
  const [viewingRecord, setViewingRecord] =
    useState<GovernanceDbRecord | null>(null);
  const [editingRecord, setEditingRecord] =
    useState<GovernanceDbRecord | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState<string>('');
  const [editDateDraft, setEditDateDraft] = useState<string>('');
  const [deletingRecord, setDeletingRecord] =
    useState<GovernanceDbRecord | null>(null);
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
  const { panHandlers, isDragging: isDraggingPreview } = useDragToPan();
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
  const liveNoteInputRef = useRef<HTMLInputElement | null>(null);

  const [recordUuid, setRecordUuid] = useState<string>(() =>
    crypto.randomUUID()
  );
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null);
  const [docRefNo, setDocRefNo] = useState<string>(() =>
    generateUniqueDocNumber([])
  );
  const [usedDocNumbers, setUsedDocNumbers] = useState<string[]>([]);
  const [usedSessionNumbers, setUsedSessionNumbers] = useState<string[]>([]);
  const [dbRecords, setDbRecords] = useState<GovernanceDbRecord[]>([]);

  const [confirmSaveOpen, setConfirmSaveOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState<boolean>(false);

  // Tab 1: Request Letter state
  const [letterDate, setLetterDate] = useState('2026-11-25');
  const [recipientName, setRecipientName] = useState('HON. PUNONG BARANGAY');
  const [recipientOffice, setRecipientOffice] = useState(
    'Office of the Punong Barangay, Barangay Kauswagan, Cagayan de Oro City'
  );
  const [letterSubject, setLetterSubject] = useState(
    'Request for Endorsement / Release of SK Program Support'
  );
  const [letterBody, setLetterBody] = useState(
    'Greetings!\n\nIn line with the approved Sangguniang Kabataan Annual Barangay Youth Investment Program (ABYIP) of Barangay Kauswagan, Cagayan de Oro City, we respectfully request your good office for endorsement and assistance regarding our upcoming youth program.\n\nAttached herewith are the pertinent documents for your perusal and favorable action.'
  );
  const [letterSignatories, setLetterSignatories] = useState<LetterSignatory[]>([
    {
      id: crypto.randomUUID(),
      name: committee.approvedBy || FIXED_SK_CHAIRPERSON,
      role: 'SK Chairperson',
    },
  ]);

  // Tab 2: Minutes of Meeting + Automated Session No. + Itemized Agenda + Timed Recording
  const [sessionNo, setSessionNo] = useState(() =>
    generateUniqueSessionNumber([])
  );
  const [sessionType, setSessionType] = useState<
    'Regular Session' | 'Special Session'
  >('Regular Session');
  const [sessionDate, setSessionDate] = useState('2026-11-25');
  const [sessionTime, setSessionTime] = useState('2:00 PM');
  const [venue, setVenue] = useState(
    'SK Session Hall, Barangay Kauswagan, Cagayan de Oro City'
  );
  const [presidingOfficer, setPresidingOfficer] = useState(
    FIXED_SK_CHAIRPERSON
  );
  const [skSecretary, setSkSecretary] = useState(FIXED_SK_SECRETARY);
  const [presentMembers, setPresentMembers] = useState(
    'HON. RANCE EMIL D. ACHACOSO (SK Chairperson), HON. EFREN F. CORPUZ (SK Kagawad), HON. SHANNEN KATE M. RAMOS (SK Kagawad), HON. RUCHELLE KYLE B. BAAL (SK Kagawad), HON. DHAR KENZOE B. OBSIOMA (SK Kagawad), HON. ABIJAH MIGUEL C. PACANA (SK Kagawad), HON. JAN MACKENXIE B. NAVARRO (SK Treasurer), SK Secretary'
  );
  const [absentMembers, setAbsentMembers] = useState('None');
  const [customPresentInput, setCustomPresentInput] = useState('');
  const [customAbsentInput, setCustomAbsentInput] = useState('');
  const [agendaItems, setAgendaItems] = useState<string[]>([
    ...DEFAULT_AGENDA_ITEMS,
  ]);
  const [newAgendaItemInput, setNewAgendaItemInput] = useState('');
  const [proceedingsNotes, setProceedingsNotes] = useState('');
  const [timedNotes, setTimedNotes] = useState<TimedNoteEntry[]>([]);
  const [isRecordingNotes, setIsRecordingNotes] = useState<boolean>(false);
  const [recordingDurationSec, setRecordingDurationSec] = useState<number>(0);
  const [liveNoteDraft, setLiveNoteDraft] = useState<string>('');

  // Tab 3: Resolutions (Proposal & Final) modeled on uploaded SK Resolution template
  const [resolutionStage, setResolutionStage] =
    useState<ResolutionStage>('proposal');
  const [resolutionNo, setResolutionNo] = useState('RESOLUTION NO. 01, s. 2026');
  const [resolutionTitle, setResolutionTitle] = useState(
    'A RESOLUTION ADOPTING AND APPROVING PRIORITY YOUTH DEVELOPMENT INITIATIVES OF THE SANGGUNIANG KABATAAN OF BARANGAY KAUSWAGAN, CAGAYAN DE ORO CITY'
  );
  const [sessionExcerptText, setSessionExcerptText] = useState(
    'Excerpt from the minutes of the meeting of the Regular Session of the Sangguniang Kabataan of Barangay Kauswagan, Cagayan de Oro City, which held at the SK Session Hall, November 25, 2026, at 2:00 o’clock in the afternoon.'
  );
  const [resolutionPresentEntries, setResolutionPresentEntries] = useState<
    ResolutionPresentEntry[]
  >([...DEFAULT_RESOLUTION_PRESENT]);
  const [customResRoleLabel, setCustomResRoleLabel] = useState('SK Kagawad');
  const [customResName, setCustomResName] = useState('');
  const [customResDesignation, setCustomResDesignation] = useState('Member');
  const [resolutionAbsentText, setResolutionAbsentText] = useState('None');
  const [introducers, setIntroducers] = useState<IntroducerEntry[]>([
    {
      name: 'HON. EFREN F. CORPUZ',
      role: 'SK Kagawad',
    },
    {
      name: 'HON. SHANNEN KATE M. RAMOS',
      role: 'SK Kagawad',
    },
  ]);
  const [whereasClauses, setWhereasClauses] = useState<string[]>([
    'WHEREAS, Section 8(c) of Republic Act No. 10742 (Sangguniang Kabataan Reform Act of 2015), as amended by Republic Act No. 11768, provides that the Sangguniang Kabataan shall promulgate resolutions necessary to carry out the objectives of the youth in the barangay in accordance with the Comprehensive Barangay Youth Development Plan (CBYDP) and Annual Barangay Youth Investment Program (ABYIP);',
    'WHEREAS, the Sangguniang Kabataan of Barangay Kauswagan, Cagayan de Oro City prioritizes youth development, governance participation, and community programs aligned with the approved youth development plans;',
  ]);
  const [nowThereforeClause, setNowThereforeClause] = useState(
    'NOW, THEREFORE, on motion duly seconded, BE IT RESOLVED by the Sangguniang Kabataan of Barangay Kauswagan, Cagayan de Oro City, in session assembled, to adopt and approve this resolution subject to existing laws, accounting, and auditing rules.'
  );
  const [resolutionDate, setResolutionDate] = useState('2026-11-25');
  const [resolutionSignatoryName, setResolutionSignatoryName] = useState(
    FIXED_SK_CHAIRPERSON
  );
  const [resolutionSignatoryRole, setResolutionSignatoryRole] =
    useState('SK Chairperson');

  // Live timer while recording meeting notes
  useEffect(() => {
    if (!isRecordingNotes) return;
    const timer = window.setInterval(() => {
      setRecordingDurationSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecordingNotes]);

  const handleStartTimedRecording = () => {
    setIsRecordingNotes(true);
    setTimeout(() => {
      liveNoteInputRef.current?.focus();
    }, 50);
  };

  const handleStopTimedRecording = () => {
    setIsRecordingNotes(false);
    if (liveNoteDraft.trim()) {
      const elapsedLabel = formatDuration(recordingDurationSec);
      const entryText = `[${elapsedLabel}] ${liveNoteDraft.trim()}`;
      setTimedNotes((prev) => [
        ...prev,
        {
          id: `tn-${crypto.randomUUID()}`,
          elapsedLabel,
          recordedAt: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          text: liveNoteDraft.trim(),
        },
      ]);
      setProceedingsNotes((prev) =>
        prev ? `${prev}\n${entryText}` : entryText
      );
      setLiveNoteDraft('');
    }
  };

  const handleAddTimedNoteEntry = () => {
    const trimmed = liveNoteDraft.trim();
    if (!trimmed) return;
    const elapsedLabel = formatDuration(recordingDurationSec);
    const entryText = `[${elapsedLabel}] ${trimmed}`;
    setTimedNotes((prev) => [
      ...prev,
      {
        id: `tn-${crypto.randomUUID()}`,
        elapsedLabel,
        recordedAt: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        text: trimmed,
      },
    ]);
    setProceedingsNotes((prev) => (prev ? `${prev}\n${entryText}` : entryText));
    setLiveNoteDraft('');
  };

  const handleResetTimer = () => {
    setIsRecordingNotes(false);
    setRecordingDurationSec(0);
    setLiveNoteDraft('');
  };

  const handleAddAgendaItem = () => {
    const trimmed = newAgendaItemInput.trim();
    if (!trimmed) return;
    setAgendaItems((prev) => [...prev, trimmed]);
    setNewAgendaItemInput('');
  };

  const handleAddResolutionPresentEntry = (entry: ResolutionPresentEntry) => {
    const cleanName = entry.name.trim();
    if (!cleanName) return;
    setResolutionPresentEntries((prev) => {
      const exists = prev.some(
        (item) => item.name.trim().toLowerCase() === cleanName.toLowerCase()
      );
      if (exists) return prev;
      return [
        ...prev,
        {
          roleLabel: entry.roleLabel.trim() || 'SK Kagawad',
          name: cleanName,
          designation: entry.designation.trim() || 'Member',
        },
      ];
    });
  };

  // Resolve logged-in user ID for isolated draft persistence
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
    () => `${GOVERNANCE_AUTOSAVE_PREFIX}_${currentUserId}`,
    [currentUserId]
  );

  const buildCurrentPayload = useCallback(
    (): GovernancePayload => ({
      activeTab,
      paperSize,
      orientation,
      docRefNo,
      letterDate,
      recipientName,
      recipientOffice,
      letterSubject,
      letterBody,
      signatoryName: letterSignatories[0]?.name || FIXED_SK_CHAIRPERSON,
      signatoryRole: letterSignatories[0]?.role || 'SK Chairperson',
      signatories: letterSignatories,
      sessionNo,
      sessionType,
      sessionDate,
      sessionTime,
      venue,
      presidingOfficer,
      skSecretary,
      presentMembers,
      absentMembers,
      agendaItems,
      proceedingsNotes,
      timedNotes,
      recordingDurationSec,
      resolutionStage,
      resolutionNo,
      resolutionTitle,
      sessionExcerptText,
      resolutionPresentEntries,
      resolutionAbsentText,
      introducers,
      whereasClauses,
      nowThereforeClause,
      resolutionDate,
      resolutionSignatoryName,
      resolutionSignatoryRole,
    }),
    [
      activeTab,
      paperSize,
      orientation,
      docRefNo,
      letterDate,
      recipientName,
      recipientOffice,
      letterSubject,
      letterBody,
      letterSignatories,
      sessionNo,
      sessionType,
      sessionDate,
      sessionTime,
      venue,
      presidingOfficer,
      skSecretary,
      presentMembers,
      absentMembers,
      agendaItems,
      proceedingsNotes,
      timedNotes,
      recordingDurationSec,
      resolutionStage,
      resolutionNo,
      resolutionTitle,
      sessionExcerptText,
      resolutionPresentEntries,
      resolutionAbsentText,
      introducers,
      whereasClauses,
      nowThereforeClause,
      resolutionDate,
      resolutionSignatoryName,
      resolutionSignatoryRole,
    ]
  );

  const applyPayloadToEditor = useCallback(
    (
      p: Partial<GovernancePayload>,
      overrideUuid?: string,
      overrideUpdatedAt?: string | null
    ) => {
      if (overrideUuid) setRecordUuid(overrideUuid);
      if (overrideUpdatedAt !== undefined) setLoadedUpdatedAt(overrideUpdatedAt);
      if (p.activeTab) setActiveTab(p.activeTab);
      if (p.paperSize) setPaperSize(p.paperSize);
      if (p.orientation) setOrientation(p.orientation);
      if (p.docRefNo) setDocRefNo(p.docRefNo);
      if (p.letterDate !== undefined) setLetterDate(p.letterDate);
      if (p.recipientName !== undefined) setRecipientName(p.recipientName);
      if (p.recipientOffice !== undefined) setRecipientOffice(p.recipientOffice);
      if (p.letterSubject !== undefined) setLetterSubject(p.letterSubject);
      if (p.letterBody !== undefined) setLetterBody(p.letterBody);
      if (Array.isArray(p.signatories) && p.signatories.length > 0) {
        setLetterSignatories(
          p.signatories.map((entry, index) => ({
            id: String(entry.id || `legacy-signatory-${index}`),
            name: String(entry.name || ''),
            role: String(entry.role || ''),
          }))
        );
      } else if (p.signatoryName !== undefined || p.signatoryRole !== undefined) {
        setLetterSignatories([{
          id: crypto.randomUUID(),
          name: String(p.signatoryName || FIXED_SK_CHAIRPERSON),
          role: String(p.signatoryRole || 'SK Chairperson'),
        }]);
      }
      if (p.sessionNo !== undefined) setSessionNo(p.sessionNo);
      if (p.sessionType) setSessionType(p.sessionType);
      if (p.sessionDate !== undefined) setSessionDate(p.sessionDate);
      if (p.sessionTime !== undefined) setSessionTime(p.sessionTime);
      if (p.venue !== undefined) setVenue(p.venue);
      if (p.presidingOfficer !== undefined)
        setPresidingOfficer(p.presidingOfficer);
      if (p.skSecretary !== undefined) setSkSecretary(p.skSecretary);
      if (p.presentMembers !== undefined) setPresentMembers(p.presentMembers);
      if (p.absentMembers !== undefined) setAbsentMembers(p.absentMembers);
      if (Array.isArray(p.agendaItems)) setAgendaItems(p.agendaItems);
      if (p.proceedingsNotes !== undefined)
        setProceedingsNotes(p.proceedingsNotes);
      if (Array.isArray(p.timedNotes)) setTimedNotes(p.timedNotes);
      if (typeof p.recordingDurationSec === 'number')
        setRecordingDurationSec(p.recordingDurationSec);
      if (p.resolutionStage) setResolutionStage(p.resolutionStage);
      if (p.resolutionNo !== undefined) setResolutionNo(p.resolutionNo);
      if (p.resolutionTitle !== undefined)
        setResolutionTitle(p.resolutionTitle);
      if (p.sessionExcerptText !== undefined)
        setSessionExcerptText(p.sessionExcerptText);
      if (Array.isArray(p.resolutionPresentEntries))
        setResolutionPresentEntries(p.resolutionPresentEntries);
      if (p.resolutionAbsentText !== undefined)
        setResolutionAbsentText(p.resolutionAbsentText);
      if (Array.isArray(p.introducers) && p.introducers.length > 0)
        setIntroducers(p.introducers);
      if (Array.isArray(p.whereasClauses) && p.whereasClauses.length > 0)
        setWhereasClauses(p.whereasClauses);
      if (p.nowThereforeClause !== undefined)
        setNowThereforeClause(p.nowThereforeClause);
      if (p.resolutionDate !== undefined) setResolutionDate(p.resolutionDate);
      if (p.resolutionSignatoryName !== undefined)
        setResolutionSignatoryName(p.resolutionSignatoryName);
      if (p.resolutionSignatoryRole !== undefined)
        setResolutionSignatoryRole(p.resolutionSignatoryRole);
    },
    []
  );

  // Restore user-scoped draft on login / user switch
  useEffect(() => {
    if (!isUserResolved) return;
    if (restoredForUserRef.current === currentUserId) return;
    restoredForUserRef.current = currentUserId;

    try {
      const raw = window.localStorage.getItem(getUserAutosaveKey());
      if (!raw) {
        setRecordUuid(crypto.randomUUID());
        setLoadedUpdatedAt(null);
        setProceedingsNotes('');
        setTimedNotes([]);
        setRecordingDurationSec(0);
        setSessionNo(generateUniqueSessionNumber(usedSessionNumbers));
        return;
      }
      const parsed = JSON.parse(raw) as {
        id?: string;
        loadedUpdatedAt?: string | null;
        payload?: Partial<GovernancePayload>;
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
  }, [
    applyPayloadToEditor,
    currentUserId,
    getUserAutosaveKey,
    isUserResolved,
    usedSessionNumbers,
  ]);

  // Persist user-scoped draft
  useEffect(() => {
    if (!isUserResolved || restoredForUserRef.current !== currentUserId) return;
    try {
      window.localStorage.setItem(
        getUserAutosaveKey(),
        JSON.stringify({
          id: recordUuid,
          loadedUpdatedAt,
          savedAt: new Date().toISOString(),
          payload: buildCurrentPayload(),
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }, [
    buildCurrentPayload,
    currentUserId,
    getUserAutosaveKey,
    isUserResolved,
    loadedUpdatedAt,
    recordUuid,
  ]);

  const currentTabMeta = TABS.find((t) => t.key === activeTab) ?? TABS[0];

  const getCurrentRecordTitle = (): string => {
    if (activeTab === 'request-letter')
      return letterSubject.trim() || `Request Letter ${docRefNo}`;
    if (activeTab === 'minutes')
      return sessionNo.trim() || `Minutes ${docRefNo}`;
    const stageLabel = resolutionStage === 'proposal' ? '[Proposal]' : '[Final]';
    return `${stageLabel} ${
      resolutionTitle.trim() || resolutionNo.trim() || docRefNo
    }`;
  };

  const getCurrentRecordDate = (): string => {
    if (activeTab === 'request-letter') return letterDate;
    if (activeTab === 'minutes') return sessionDate;
    return resolutionDate;
  };

  const hydrateNumbersFromDbRows = useCallback((rows: GovernanceDbRecord[]) => {
    const nos = rows
      .map((r) => r.finalId || r.payload?.docRefNo)
      .filter((v): v is string => Boolean(v));
    const sessNos = rows
      .filter((r) => r.docType === 'minutes')
      .map((r) => r.payload?.sessionNo)
      .filter((v): v is string => Boolean(v));

    setUsedDocNumbers((prev) => Array.from(new Set([...prev, ...nos])));
    setUsedSessionNumbers((prev) => Array.from(new Set([...prev, ...sessNos])));

    setDocRefNo((curr) =>
      nos.includes(curr) ? generateUniqueDocNumber(nos) : curr
    );
    setSessionNo((curr) =>
      sessNos.map((s) => s.toUpperCase()).includes(curr.toUpperCase())
        ? generateUniqueSessionNumber(sessNos)
        : curr
    );
  }, []);

  const loadGovernanceRecordsFromSupabase = useCallback(async () => {
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);

    const collected: GovernanceDbRecord[] = [];

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
            ? (row.payload as Partial<GovernancePayload>)
            : {};

        const finalId = String(
          row.doc_ref_no ?? savedPayload.docRefNo ?? generateUniqueDocNumber([])
        );

        const recTitle = String(
          row.title ??
            savedPayload.letterSubject ??
            savedPayload.sessionNo ??
            savedPayload.resolutionTitle ??
            `Untitled ${tab.label}`
        );

        const recDate = String(
          row.doc_date ??
            savedPayload.letterDate ??
            savedPayload.sessionDate ??
            savedPayload.resolutionDate ??
            ''
        );

        const parsedAgendaItems = Array.isArray(row.agenda_items)
          ? (row.agenda_items as string[])
          : Array.isArray(savedPayload.agendaItems)
            ? savedPayload.agendaItems
            : typeof row.agenda === 'string' && row.agenda.trim()
              ? row.agenda
                  .split('\n')
                  .map((line) => line.replace(/^\d+[\.)]\s*/, '').trim())
                  .filter(Boolean)
              : [...DEFAULT_AGENDA_ITEMS];

        const parsedPresentEntries = Array.isArray(
          row.resolution_present_entries
        )
          ? (row.resolution_present_entries as ResolutionPresentEntry[])
          : Array.isArray(savedPayload.resolutionPresentEntries)
            ? savedPayload.resolutionPresentEntries
            : [...DEFAULT_RESOLUTION_PRESENT];

        const parsedIntroducers = Array.isArray(row.introducers)
          ? (row.introducers as IntroducerEntry[])
          : Array.isArray(savedPayload.introducers) &&
              savedPayload.introducers.length > 0
            ? savedPayload.introducers
            : [
                {
                  name: String(row.introduced_by ?? ''),
                  role: 'SK Kagawad',
                },
              ];

        const payload: GovernancePayload = {
          activeTab: tab.key,
          paperSize:
            (row.paper_size as PaperSizeKey) || savedPayload.paperSize || 'a4',
          orientation:
            (row.orientation as PaperOrientation) ||
            savedPayload.orientation ||
            'portrait',
          docRefNo: finalId,
          letterDate: String(
            row.doc_date ?? savedPayload.letterDate ?? '2026-11-25'
          ),
          recipientName: String(
            row.recipient_name ??
              savedPayload.recipientName ??
              'HON. PUNONG BARANGAY'
          ),
          recipientOffice: String(
            row.recipient_office ?? savedPayload.recipientOffice ?? ''
          ),
          letterSubject: String(row.title ?? savedPayload.letterSubject ?? ''),
          letterBody: String(row.body ?? savedPayload.letterBody ?? ''),
          signatoryName: String(
            row.signatory_name ?? savedPayload.signatoryName ?? FIXED_SK_CHAIRPERSON
          ),
          signatoryRole: String(
            row.signatory_role ?? savedPayload.signatoryRole ?? 'SK Chairperson'
          ),
          signatories: Array.isArray(savedPayload.signatories) && savedPayload.signatories.length > 0
            ? savedPayload.signatories
            : [{
                id: `legacy-${String(row.id ?? 'signatory')}`,
                name: String(row.signatory_name ?? savedPayload.signatoryName ?? FIXED_SK_CHAIRPERSON),
                role: String(row.signatory_role ?? savedPayload.signatoryRole ?? 'SK Chairperson'),
              }],
          sessionNo: String(
            row.session_no ??
              savedPayload.sessionNo ??
              generateUniqueSessionNumber([])
          ),
          sessionType:
            row.session_type === 'Special Session' ||
            savedPayload.sessionType === 'Special Session'
              ? 'Special Session'
              : 'Regular Session',
          sessionDate: String(
            row.doc_date ?? savedPayload.sessionDate ?? '2026-11-25'
          ),
          sessionTime: String(
            row.session_time ?? savedPayload.sessionTime ?? '2:00 PM'
          ),
          venue: String(row.venue ?? savedPayload.venue ?? ''),
          presidingOfficer: String(
            row.presiding_officer ??
              savedPayload.presidingOfficer ??
              FIXED_SK_CHAIRPERSON
          ),
          skSecretary: String(
            row.sk_secretary ?? savedPayload.skSecretary ?? FIXED_SK_SECRETARY
          ),
          presentMembers: String(
            row.present_members ?? savedPayload.presentMembers ?? ''
          ),
          absentMembers: String(
            row.absent_members ?? savedPayload.absentMembers ?? 'None'
          ),
          agendaItems: parsedAgendaItems,
          proceedingsNotes: String(
            row.proceedings_notes ?? savedPayload.proceedingsNotes ?? ''
          ),
          timedNotes: Array.isArray(row.timed_notes)
            ? (row.timed_notes as TimedNoteEntry[])
            : savedPayload.timedNotes ?? [],
          recordingDurationSec:
            typeof row.recording_duration_sec === 'number'
              ? row.recording_duration_sec
              : savedPayload.recordingDurationSec ?? 0,
          resolutionStage:
            row.resolution_stage === 'final' ||
            savedPayload.resolutionStage === 'final'
              ? 'final'
              : 'proposal',
          resolutionNo: String(
            row.resolution_no ??
              savedPayload.resolutionNo ??
              'RESOLUTION NO. 01, s. 2026'
          ),
          resolutionTitle: String(
            row.title ?? savedPayload.resolutionTitle ?? ''
          ),
          sessionExcerptText: String(
            row.session_excerpt_text ?? savedPayload.sessionExcerptText ?? ''
          ),
          resolutionPresentEntries: parsedPresentEntries,
          resolutionAbsentText: String(
            row.resolution_absent_text ??
              savedPayload.resolutionAbsentText ??
              'None'
          ),
          introducers: parsedIntroducers,
          whereasClauses: Array.isArray(row.whereas_clauses)
            ? (row.whereas_clauses as string[])
            : savedPayload.whereasClauses ?? [],
          nowThereforeClause: String(
            row.now_therefore_clause ?? savedPayload.nowThereforeClause ?? ''
          ),
          resolutionDate: String(
            row.doc_date ?? savedPayload.resolutionDate ?? '2026-11-25'
          ),
          resolutionSignatoryName: String(
            row.resolution_signatory_name ??
              savedPayload.resolutionSignatoryName ??
              FIXED_SK_CHAIRPERSON
          ),
          resolutionSignatoryRole: String(
            row.resolution_signatory_role ??
              savedPayload.resolutionSignatoryRole ??
              'SK Chairperson'
          ),
        };

        collected.push({
          id,
          finalId,
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
  }, [hydrateNumbersFromDbRows]);

  // Initial connection + Realtime multi-user sync
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
      await loadGovernanceRecordsFromSupabase();
    };

    void initConnectionAndLoad();

    const channel = supabase
      .channel('governance-realtime-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'governance_request_letters' },
        () => {
          if (active) void loadGovernanceRecordsFromSupabase();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'governance_minutes' },
        () => {
          if (active) void loadGovernanceRecordsFromSupabase();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'governance_resolutions' },
        () => {
          if (active) void loadGovernanceRecordsFromSupabase();
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
  }, [loadGovernanceRecordsFromSupabase]);

  const requestSaveConfirmation = async () => {
    if (isRecordingNotes) {
      handleStopTimedRecording();
    }
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);
    if (!confirmSaveOpen && !isSaving) {
      setConfirmSaveOpen(true);
    }
  };

  // Enter saves ONLY when not actively recording timed notes
  useEnterToSave({
    enabled:
      isSupabaseConnected &&
      !isConnectingSupabase &&
      !isRecordingNotes &&
      !confirmSaveOpen &&
      !isDatabaseDialogOpen &&
      !viewingRecord &&
      !editingRecord &&
      !deletingRecord &&
      !statusDialog.open,
    onTriggerSave: () => {
      void requestSaveConfirmation();
    },
  });

  const buildSupabaseRowForTab = (
    resolvedRefNo: string,
    resolvedSessionNo: string
  ): Record<string, unknown> => {
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(getCurrentRecordDate())
      ? getCurrentRecordDate()
      : null;
    const payloadSnapshot = buildCurrentPayload();

    if (activeTab === 'request-letter') {
      return {
        id: recordUuid,
        doc_ref_no: resolvedRefNo,
        title: letterSubject.trim() || 'Request Letter',
        doc_date: validDate,
        recipient_name: recipientName,
        recipient_office: recipientOffice,
        body: letterBody,
        signatory_name: letterSignatories[0]?.name || FIXED_SK_CHAIRPERSON,
        signatory_role: letterSignatories[0]?.role || 'SK Chairperson',
        paper_size: paperSize,
        orientation,
        payload: payloadSnapshot,
      };
    }

    if (activeTab === 'minutes') {
      const formattedAgenda = agendaItems
        .map((item, i) => `${i + 1}. ${item}`)
        .join('\n');
      return {
        id: recordUuid,
        doc_ref_no: resolvedRefNo,
        title: resolvedSessionNo,
        doc_date: validDate,
        session_no: resolvedSessionNo,
        session_type: sessionType,
        session_time: sessionTime,
        venue,
        presiding_officer: presidingOfficer,
        sk_secretary: skSecretary,
        present_members: presentMembers,
        absent_members: absentMembers,
        agenda_items: agendaItems,
        agenda: formattedAgenda,
        proceedings_notes: proceedingsNotes,
        timed_notes: timedNotes,
        recording_duration_sec: recordingDurationSec,
        paper_size: paperSize,
        orientation,
        payload: { ...payloadSnapshot, sessionNo: resolvedSessionNo },
      };
    }

    return {
      id: recordUuid,
      doc_ref_no: resolvedRefNo,
      title: resolutionTitle.trim() || resolutionNo.trim() || 'SK Resolution',
      doc_date: validDate,
      resolution_stage: resolutionStage,
      resolution_no: resolutionNo,
      session_excerpt_text: sessionExcerptText,
      resolution_present_entries: resolutionPresentEntries,
      resolution_absent_text: resolutionAbsentText,
      introducers,
      whereas_clauses: whereasClauses,
      now_therefore_clause: nowThereforeClause,
      resolution_signatory_name: resolutionSignatoryName,
      resolution_signatory_role: resolutionSignatoryRole,
      paper_size: paperSize,
      orientation,
      payload: payloadSnapshot,
    };
  };

  const handleSaveToSupabase = async (): Promise<GovernanceDbRecord[]> => {
    await ensureSupabaseConnected(setIsConnectingSupabase);
    setIsSupabaseConnected(true);

    const { data: existingRows, error: fetchError } = await supabase
      .from(currentTabMeta.tableName as never)
      .select('id, doc_ref_no, session_no, updated_at');

    if (fetchError) {
      throw new Error(fetchError.message);
    }

    const existingList = (existingRows ?? []) as {
      id: string;
      doc_ref_no?: string;
      session_no?: string;
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
        'Concurrent edit conflict: Another user modified this record while you were editing it. Open Database and reload the latest version before saving.'
      );
    }

    const dbNos = existingList
      .filter((r) => r.id !== recordUuid)
      .map((r) => r.doc_ref_no)
      .filter((v): v is string => Boolean(v));

    let resolvedRefNo = docRefNo.trim() || generateUniqueDocNumber(dbNos);
    if (!existingSameRecord && dbNos.includes(resolvedRefNo)) {
      resolvedRefNo = generateUniqueDocNumber([...dbNos, ...usedDocNumbers]);
    }
    setDocRefNo(resolvedRefNo);

    const dbSessionNos = existingList
      .filter((r) => r.id !== recordUuid)
      .map((r) => r.session_no)
      .filter((v): v is string => Boolean(v));

    let resolvedSessionNo =
      sessionNo.trim() || generateUniqueSessionNumber(dbSessionNos);
    if (
      !existingSameRecord &&
      dbSessionNos
        .map((s) => s.toUpperCase())
        .includes(resolvedSessionNo.toUpperCase())
    ) {
      resolvedSessionNo = generateUniqueSessionNumber([
        ...dbSessionNos,
        ...usedSessionNumbers,
      ]);
    }
    setSessionNo(resolvedSessionNo);

    const row = buildSupabaseRowForTab(resolvedRefNo, resolvedSessionNo);
    const { error } = await supabase
      .from(currentTabMeta.tableName as never)
      .upsert(row as never, { onConflict: 'id' });

    if (error) {
      throw new Error(error.message);
    }

    const latest = await loadGovernanceRecordsFromSupabase();
    showStatus(
      'success',
      'Saved to Supabase',
      `Saved "${getCurrentRecordTitle()}" (${resolvedRefNo}) to ${currentTabMeta.tableName}.`
    );
    return latest;
  };

  const handleConfirmSave = async () => {
    setIsSaving(true);
    try {
      const latest = await handleSaveToSupabase();
      const dbNos = latest.map((r) => r.finalId || r.payload?.docRefNo);
      const dbSessNos = latest
        .filter((r) => r.docType === 'minutes')
        .map((r) => r.payload?.sessionNo)
        .filter((v): v is string => Boolean(v));

      const nextNo = generateUniqueDocNumber([
        ...usedDocNumbers,
        ...dbNos,
        docRefNo,
      ]);
      const nextSessionNo = generateUniqueSessionNumber([
        ...usedSessionNumbers,
        ...dbSessNos,
        sessionNo,
      ]);

      setUsedDocNumbers((prev) =>
        Array.from(new Set([...prev, ...dbNos, docRefNo, nextNo]))
      );
      setUsedSessionNumbers((prev) =>
        Array.from(new Set([...prev, ...dbSessNos, sessionNo, nextSessionNo]))
      );
      setRecordUuid(crypto.randomUUID());
      setLoadedUpdatedAt(null);
      setDocRefNo(nextNo);
      setSessionNo(nextSessionNo);
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
    const dbNos = dbRecords.map((r) => r.finalId || r.payload?.docRefNo);
    const dbSessNos = dbRecords
      .filter((r) => r.docType === 'minutes')
      .map((r) => r.payload?.sessionNo)
      .filter((v): v is string => Boolean(v));

    const nextNo = generateUniqueDocNumber([...usedDocNumbers, ...dbNos, docRefNo]);
    const nextSessionNo = generateUniqueSessionNumber([
      ...usedSessionNumbers,
      ...dbSessNos,
      sessionNo,
    ]);

    setUsedDocNumbers((prev) => Array.from(new Set([...prev, docRefNo, nextNo])));
    setUsedSessionNumbers((prev) =>
      Array.from(new Set([...prev, sessionNo, nextSessionNo]))
    );
    setRecordUuid(crypto.randomUUID());
    setLoadedUpdatedAt(null);
    setDocRefNo(nextNo);
    setSessionNo(nextSessionNo);
    setAgendaItems([...DEFAULT_AGENDA_ITEMS]);
    setIsRecordingNotes(false);
    setRecordingDurationSec(0);
    setLiveNoteDraft('');
    setProceedingsNotes('');
    setTimedNotes([]);
  };

  const openEditDialog = (rec: GovernanceDbRecord) => {
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

    applyPayloadToEditor(
      {
        ...p,
        letterSubject:
          p.activeTab === 'request-letter' ? nextTitle : p.letterSubject,
        letterDate: p.activeTab === 'request-letter' ? nextDate : p.letterDate,
        sessionNo: p.activeTab === 'minutes' ? nextTitle : p.sessionNo,
        sessionDate: p.activeTab === 'minutes' ? nextDate : p.sessionDate,
        resolutionTitle:
          p.activeTab === 'resolutions' ? nextTitle : p.resolutionTitle,
        resolutionDate:
          p.activeTab === 'resolutions' ? nextDate : p.resolutionDate,
      },
      rec.id,
      rec.updatedAt || null
    );

    setEditingRecord(null);
    setIsDatabaseDialogOpen(false);
    showStatus(
      'info',
      'Record Loaded',
      `Loaded ${rec.finalId || rec.title} into the editor.`
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

      await loadGovernanceRecordsFromSupabase();
      if (viewingRecord?.id === rec.id) {
        setViewingRecord(null);
      }
      setDeletingRecord(null);
      showStatus(
        'success',
        'Record Deleted',
        `Deleted ${rec.title || rec.finalId} from ${rec.tableName}.`
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

          captureHost.style.width = `${pageWidthMm}mm`;
          captureHost.style.maxWidth = `${pageWidthMm}mm`;
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
          captureClone.style.overflow = 'visible';

          // Keep the rendered content inside the physical paper width. This is
          // particularly important for wide tables on landscape paper.
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
            // Wait until layout, fonts and embedded images are ready before
            // measuring; first-load capture otherwise sometimes gets zero size.
            await (document.fonts?.ready ?? Promise.resolve());
            await Promise.all(Array.from(captureClone.querySelectorAll('img')).map((img) => {
              if (img.complete && img.naturalWidth > 0) {
                return typeof img.decode === 'function' ? img.decode().catch(() => undefined) : Promise.resolve();
              }
              return new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              });
            }));
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });

            const captureRect = captureClone.getBoundingClientRect();
            const captureWidth = Math.ceil(captureRect.width || captureClone.offsetWidth);
            const captureHeight = Math.ceil(Math.max(captureClone.scrollHeight, captureRect.height));
            if (!captureWidth || !captureHeight) {
              throw new Error('The document page has no measurable size yet.');
            }

            canvas = await html2canvas(captureClone, {
              scale: Math.min(3, Math.max(2, window.devicePixelRatio || 2)),
              useCORS: true,
              backgroundColor: "#ffffff",
              logging: false,
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
  }, [
    pageWidthMm,
    pageMinHeightMm,
    activeTab,
    orientation,
    buildCurrentPayload,
    isConnectingSupabase,
    isSupabaseConnected,
  ]);

  const handleDownloadPdf = async () => {
    const sheet = sheetRef.current;
    if (!sheet || isDownloadingPdf) return;

    closeStatusDialog();
    const code = sanitizeFileSegment(getCurrentRecordTitle() || activeTab);
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
        'The print dialog has been closed.'
      );
    };
    window.addEventListener('afterprint', onAfterPrint);
    setTimeout(() => window.print(), 100);
  };

  const renderFormInputs = () => {
    if (activeTab === 'request-letter') {
      return (
        <div className="space-y-3">
          <div className="space-y-2.5">
            <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form ID · Automatically Generated</span>
              <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{docRefNo}</span>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Date (YYYY-MM-DD)
              </label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={letterDate}
                onChange={(e) =>
                  setLetterDate(formatAutoDashDate(e.target.value))
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              Recipient Name / Title
            </label>
            <input
              type="text"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              Recipient Office / Address
            </label>
            <input
              type="text"
              value={recipientOffice}
              onChange={(e) => setRecipientOffice(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              Subject
            </label>
            <input
              type="text"
              value={letterSubject}
              onChange={(e) => setLetterSubject(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              Letter Body
            </label>
            <textarea
              rows={6}
              value={letterBody}
              onChange={(e) => setLetterBody(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs leading-relaxed"
            />
          </div>

          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-slate-800">Signatories</p>
                <p className="text-[10px] text-slate-500">Add one or more people who will sign this letter.</p>
              </div>
              <button
                type="button"
                onClick={() => setLetterSignatories((previous) => [...previous, { id: crypto.randomUUID(), name: '', role: '' }])}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-[11px] font-semibold text-sky-800 hover:bg-sky-100"
              >
                <Plus className="h-3 w-3" /> Add Signatory
              </button>
            </div>
            {letterSignatories.map((signatory, index) => (
              <div key={signatory.id} className="grid grid-cols-1 gap-2 rounded-md bg-slate-50 p-2.5 sm:grid-cols-[1fr_1fr_auto]">
                <label className="block text-[11px] font-medium text-slate-600">
                  {index + 1}. Signatory Name
                  <input
                    type="text"
                    value={signatory.name}
                    onChange={(event) => setLetterSignatories((previous) => previous.map((entry) => entry.id === signatory.id ? { ...entry, name: event.target.value } : entry))}
                    placeholder="Full name"
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-normal text-slate-900"
                  />
                </label>
                <label className="block text-[11px] font-medium text-slate-600">
                  Position / Role
                  <input
                    type="text"
                    value={signatory.role}
                    onChange={(event) => setLetterSignatories((previous) => previous.map((entry) => entry.id === signatory.id ? { ...entry, role: event.target.value } : entry))}
                    placeholder="e.g. SK Chairperson"
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-normal text-slate-900"
                  />
                </label>
                <button
                  type="button"
                  disabled={letterSignatories.length <= 1}
                  onClick={() => setLetterSignatories((previous) => previous.length > 1 ? previous.filter((entry) => entry.id !== signatory.id) : previous)}
                  className="self-end rounded border border-rose-200 px-2 py-1.5 text-[10px] font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (activeTab === 'minutes') {
      const presentList = splitAttendeeList(presentMembers);
      const absentList = splitAttendeeList(absentMembers);

      return (
        <div className="space-y-3">
          <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form ID · Automatically Generated</span>
            <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{docRefNo}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Session No. (Auto)
              </label>
              <input
                type="text"
                value={sessionNo}
                readOnly
                className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-mono font-semibold text-slate-700"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Session Type
              </label>
              <select
                value={sessionType}
                onChange={(e) =>
                  setSessionType(
                    e.target.value as 'Regular Session' | 'Special Session'
                  )
                }
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                <option value="Regular Session">Regular Session</option>
                <option value="Special Session">Special Session</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Date (YYYY-MM-DD)
              </label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={sessionDate}
                onChange={(e) =>
                  setSessionDate(formatAutoDashDate(e.target.value))
                }
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Time Started
              </label>
              <input
                type="text"
                value={sessionTime}
                onChange={(e) => setSessionTime(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              Venue
            </label>
            <input
              type="text"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-700">
                Presiding Officer
              </label>
              <input
                type="text"
                value={presidingOfficer}
                onChange={(e) => setPresidingOfficer(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                SK Secretary
              </label>
              <input
                type="text"
                value={skSecretary}
                onChange={(e) => setSkSecretary(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </div>
          </div>

          {/* Present Dropdown + Add Not in System */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
            <label className="block text-xs font-medium text-slate-700">
              Present
            </label>
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setPresentMembers((prev) =>
                  appendAttendee(prev, e.target.value)
                );
                e.target.value = '';
              }}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            >
              <option value="">Select SK Member to add to Present...</option>
              {SK_MEMBER_OPTIONS.map((opt) => (
                <option key={`pres-opt-${opt}`} value={opt}>
                  {opt}
                </option>
              ))}
            </select>

            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Add person not in the system..."
                value={customPresentInput}
                onChange={(e) => setCustomPresentInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customPresentInput.trim()) {
                    e.preventDefault();
                    setPresentMembers((prev) =>
                      appendAttendee(prev, customPresentInput)
                    );
                    setCustomPresentInput('');
                  }
                }}
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  if (!customPresentInput.trim()) return;
                  setPresentMembers((prev) =>
                    appendAttendee(prev, customPresentInput)
                  );
                  setCustomPresentInput('');
                }}
                className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 cursor-pointer"
              >
                <UserPlus className="h-3 w-3" /> Add
              </button>
            </div>

            {presentList.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {presentList.map((person) => (
                  <span
                    key={`p-tag-${person}`}
                    className="inline-flex items-center gap-1 rounded bg-white border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-800"
                  >
                    <span>{person}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const next = presentList.filter((x) => x !== person);
                        setPresentMembers(next.join(', '));
                      }}
                      className="text-slate-400 hover:text-rose-600 cursor-pointer"
                      aria-label={`Remove ${person}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Absent Dropdown + Add Not in System */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
            <label className="block text-xs font-medium text-slate-700">
              Absent
            </label>
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                if (e.target.value === '__NONE__') {
                  setAbsentMembers('None');
                } else {
                  setAbsentMembers((prev) =>
                    appendAttendee(prev, e.target.value)
                  );
                }
                e.target.value = '';
              }}
              className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
            >
              <option value="">Select Absent status or SK Member...</option>
              <option value="__NONE__">None</option>
              {SK_MEMBER_OPTIONS.map((opt) => (
                <option key={`abs-opt-${opt}`} value={opt}>
                  {opt}
                </option>
              ))}
            </select>

            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Add absent person not in the system..."
                value={customAbsentInput}
                onChange={(e) => setCustomAbsentInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customAbsentInput.trim()) {
                    e.preventDefault();
                    setAbsentMembers((prev) =>
                      appendAttendee(prev, customAbsentInput)
                    );
                    setCustomAbsentInput('');
                  }
                }}
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  if (!customAbsentInput.trim()) return;
                  setAbsentMembers((prev) =>
                    appendAttendee(prev, customAbsentInput)
                  );
                  setCustomAbsentInput('');
                }}
                className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 cursor-pointer"
              >
                <UserPlus className="h-3 w-3" /> Add
              </button>
            </div>

            {absentList.length > 0 ? (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {absentList.map((person) => (
                  <span
                    key={`a-tag-${person}`}
                    className="inline-flex items-center gap-1 rounded bg-white border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-800"
                  >
                    <span>{person}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const next = absentList.filter((x) => x !== person);
                        setAbsentMembers(
                          next.length > 0 ? next.join(', ') : 'None'
                        );
                      }}
                      className="text-slate-400 hover:text-rose-600 cursor-pointer"
                      aria-label={`Remove ${person}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">Current: None</p>
            )}
          </div>

          {/* Itemized Auto-Numbered Agenda */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-slate-700">
                Agenda (Auto-Numbered)
              </label>
              <span className="text-[10px] font-medium text-slate-500">
                {agendaItems.length} item{agendaItems.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="space-y-1.5">
              {agendaItems.map((item, idx) => (
                <div key={`ag-${idx}`} className="flex items-center gap-1.5">
                  <span className="w-5 text-right font-mono text-xs font-semibold text-slate-700">
                    {idx + 1}.
                  </span>
                  <input
                    type="text"
                    value={item}
                    onChange={(e) =>
                      setAgendaItems((prev) =>
                        prev.map((val, i) => (i === idx ? e.target.value : val))
                      )
                    }
                    className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                  {agendaItems.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setAgendaItems((prev) =>
                          prev.filter((_, i) => i !== idx)
                        )
                      }
                      className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
                      aria-label={`Remove agenda item ${idx + 1}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-1.5 pt-1">
              <input
                type="text"
                placeholder="Add new agenda item..."
                value={newAgendaItemInput}
                onChange={(e) => setNewAgendaItemInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newAgendaItemInput.trim()) {
                    e.preventDefault();
                    handleAddAgendaItem();
                  }
                }}
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={handleAddAgendaItem}
                className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 cursor-pointer"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
          </div>

          {/* Timed Note Recorder with Start / Stop & Enter-to-Stamp */}
          <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    isRecordingNotes
                      ? 'bg-rose-600 animate-pulse'
                      : 'bg-slate-400'
                  }`}
                />
                <span className="text-xs font-semibold text-slate-900">
                  Timed Note Recorder
                </span>
              </div>
              <span className="rounded bg-white border border-slate-300 px-2 py-0.5 font-mono text-xs font-bold text-slate-900">
                {formatDuration(recordingDurationSec)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {!isRecordingNotes ? (
                <button
                  type="button"
                  onClick={handleStartTimedRecording}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-800 cursor-pointer"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Start Recording</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopTimedRecording}
                  className="inline-flex items-center gap-1 rounded-md bg-rose-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-800 cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5" />
                  <span>Stop & Edit</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleResetTimer}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Reset Timer</span>
              </button>
            </div>

            {isRecordingNotes && (
              <div className="space-y-1.5 pt-1">
                <label className="block text-[11px] font-medium text-slate-700">
                  Live Note at [{formatDuration(recordingDurationSec)}] • Press{' '}
                  <kbd className="rounded border border-slate-300 bg-white px-1 py-0.5 font-mono text-[10px]">
                    Enter
                  </kbd>{' '}
                  to Stamp
                </label>
                <div className="flex gap-1.5">
                  <input
                    ref={liveNoteInputRef}
                    type="text"
                    placeholder="Type note and press Enter to Stamp..."
                    value={liveNoteDraft}
                    onChange={(e) => setLiveNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleAddTimedNoteEntry();
                      }
                    }}
                    className="flex-1 rounded border border-sky-300 bg-white px-2.5 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleAddTimedNoteEntry}
                    className="rounded-md bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-800 cursor-pointer"
                  >
                    Stamp
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700">
                Recorded & Editable Proceedings (Edit freely before saving)
              </label>
              <textarea
                rows={5}
                placeholder="Start recording to capture timed notes, or type/edit proceedings here before saving..."
                value={proceedingsNotes}
                onChange={(e) => setProceedingsNotes(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs leading-relaxed"
              />
            </div>
          </div>
        </div>
      );
    }

    // Resolutions (Proposal & Final) modeled on uploaded template
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-sky-100 bg-slate-50 px-3 py-2">
          <span className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">Form ID · Automatically Generated</span>
          <span className="mt-0.5 block font-mono text-xs font-semibold text-slate-800">{docRefNo}</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Copy Stage
            </label>
            <select
              value={resolutionStage}
              onChange={(e) =>
                setResolutionStage(e.target.value as ResolutionStage)
              }
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900"
            >
              <option value="proposal">Proposal Copy</option>
              <option value="final">Final Copy</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Date (YYYY-MM-DD)
            </label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
              value={resolutionDate}
              onChange={(e) =>
                setResolutionDate(formatAutoDashDate(e.target.value))
              }
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            Resolution No.
          </label>
          <input
            type="text"
            value={resolutionNo}
            onChange={(e) => setResolutionNo(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs font-semibold"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            Resolution Title
          </label>
          <textarea
            rows={3}
            value={resolutionTitle}
            onChange={(e) => setResolutionTitle(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            Session Excerpt Line
          </label>
          <textarea
            rows={3}
            value={sessionExcerptText}
            onChange={(e) => setSessionExcerptText(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        {/* Present Roster (Dropdown + Add Custom by Typing) */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-slate-700">
              Present ({resolutionPresentEntries.length})
            </label>
          </div>

          <select
            value=""
            onChange={(e) => {
              const selected = RESOLUTION_ROSTER_PRESETS.find(
                (p) => p.label === e.target.value
              );
              if (selected) {
                handleAddResolutionPresentEntry(selected.entry);
              }
              e.target.value = '';
            }}
            className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
          >
            <option value="">Select SK Official to add to Present...</option>
            {RESOLUTION_ROSTER_PRESETS.map((preset) => (
              <option key={preset.label} value={preset.label}>
                {preset.label}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-1 gap-1.5 pt-1">
            <div className="grid grid-cols-2 gap-1.5">
              <input
                type="text"
                placeholder="Role (e.g. SK Kagawad)"
                value={customResRoleLabel}
                onChange={(e) => setCustomResRoleLabel(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <input
                type="text"
                placeholder="Designation (e.g. Member)"
                value={customResDesignation}
                onChange={(e) => setCustomResDesignation(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                placeholder="Type full name to add..."
                value={customResName}
                onChange={(e) => setCustomResName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customResName.trim()) {
                    e.preventDefault();
                    handleAddResolutionPresentEntry({
                      roleLabel: customResRoleLabel,
                      name: customResName,
                      designation: customResDesignation,
                    });
                    setCustomResName('');
                  }
                }}
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  if (!customResName.trim()) return;
                  handleAddResolutionPresentEntry({
                    roleLabel: customResRoleLabel,
                    name: customResName,
                    designation: customResDesignation,
                  });
                  setCustomResName('');
                }}
                className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 cursor-pointer"
              >
                <UserPlus className="h-3 w-3" /> Add
              </button>
            </div>
          </div>

          {resolutionPresentEntries.length > 0 && (
            <div className="space-y-1 pt-1 max-h-40 overflow-y-auto">
              {resolutionPresentEntries.map((entry, idx) => (
                <div
                  key={`res-p-${idx}`}
                  className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1 text-[11px]"
                >
                  <span className="truncate text-slate-800">
                    <strong>{entry.roleLabel}</strong> — {entry.name} (
                    {entry.designation})
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setResolutionPresentEntries((prev) =>
                        prev.filter((_, i) => i !== idx)
                      )
                    }
                    className="text-slate-400 hover:text-rose-600 shrink-0 cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            Absent
          </label>
          <input
            type="text"
            value={resolutionAbsentText}
            onChange={(e) => setResolutionAbsentText(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        {/* Introduced By (multiple persons) */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-slate-700">
              Introduced By
            </label>
            <button
                type="button"
                onClick={() =>
                  setIntroducers((prev) => [
                    ...prev,
                    { name: '', role: 'SK Kagawad' },
                  ])
                }
                className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100 cursor-pointer"
              >
                <Plus className="h-3 w-3" /> Add Introducer
            </button>
          </div>

          <datalist id="governance-introducer-name-options">
            {Array.from(new Set(introducers.map((item) => item.name).filter(Boolean))).map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <datalist id="governance-introducer-role-options">
            {Array.from(new Set(introducers.map((item) => item.role).filter(Boolean))).map((role) => (
              <option key={role} value={role} />
            ))}
            <option value="SK Kagawad" />
            <option value="SK Chairperson" />
            <option value="SK Secretary" />
          </datalist>

          {introducers.map((intro, idx) => (
            <div
              key={`intro-${idx}`}
              className="rounded border border-slate-200 bg-white p-2 space-y-1.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-600">
                  Introducer {idx + 1}
                </span>
                {introducers.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setIntroducers((prev) =>
                        prev.filter((_, i) => i !== idx)
                      )
                    }
                    className="text-rose-500 hover:text-rose-700 cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
              <input
                type="text"
                placeholder="Name (type or choose)"
                list="governance-introducer-name-options"
                value={intro.name}
                onChange={(e) =>
                  setIntroducers((prev) =>
                    prev.map((item, i) =>
                      i === idx ? { ...item, name: e.target.value } : item
                    )
                  )
                }
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
              />
              <input
                type="text"
                placeholder="Role / Committee (type or choose)"
                list="governance-introducer-role-options"
                value={intro.role}
                onChange={(e) =>
                  setIntroducers((prev) =>
                    prev.map((item, i) =>
                      i === idx ? { ...item, role: e.target.value } : item
                    )
                  )
                }
                className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
              />
            </div>
          ))}
        </div>

        <div className="space-y-1.5 pt-2 border-t border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-800">
              WHEREAS Clauses ({whereasClauses.length})
            </span>
            <button
              type="button"
              onClick={() =>
                setWhereasClauses((prev) => [...prev, ''])
              }
              className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100 cursor-pointer"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
          {whereasClauses.map((clause, idx) => (
            <div key={`wh-${idx}`} className="flex gap-1.5 items-start">
              <textarea
                rows={3}
                value={stripClausePrefix(clause)}
                onChange={(e) =>
                  setWhereasClauses((prev) =>
                    prev.map((c, i) => (i === idx ? e.target.value : c))
                  )
                }
                className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
              />
              {whereasClauses.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setWhereasClauses((prev) =>
                      prev.filter((_, i) => i !== idx)
                    )
                  }
                  className="rounded p-1 text-rose-500 hover:bg-rose-50 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">
            NOW, THEREFORE Clause
          </label>
          <textarea
            rows={3}
            value={stripClausePrefix(nowThereforeClause)}
            onChange={(e) => setNowThereforeClause(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Signatory Name
            </label>
            <input
              type="text"
              value={resolutionSignatoryName}
              onChange={(e) => setResolutionSignatoryName(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Signatory Role
            </label>
            <input
              type="text"
              value={resolutionSignatoryRole}
              onChange={(e) => setResolutionSignatoryRole(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </div>
        </div>
      </div>
    );
  };

  const renderPaperSheetFromPayload = (p: GovernancePayload) => {
    const docType = p.activeTab || 'request-letter';

    if (docType === 'request-letter') {
      return (
        <div style={TIMES_NEW_ROMAN_STYLE} className="text-xs text-slate-900">
          <SkBannerHeader />

          <div className="mt-6 text-xs text-slate-900">
            {p.letterDate || ''}
          </div>

          <div className="mt-4 space-y-0.5 text-xs">
            <p className="font-bold uppercase text-slate-950">
              {p.recipientName || ''}
            </p>
            <p className="text-slate-800">{p.recipientOffice || ''}</p>
          </div>

          <div className="mt-5 text-xs">
            <span className="font-bold uppercase">SUBJECT: </span>
            <span className="font-semibold underline">
              {p.letterSubject || ''}
            </span>
          </div>

          <div className="mt-5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] text-xs leading-relaxed text-slate-900">
            {p.letterBody || ''}
          </div>

          <div className="mt-10 text-xs">
            <p>Respectfully yours,</p>
            <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-8">
              {(Array.isArray(p.signatories) && p.signatories.length > 0
                ? p.signatories
                : [{ id: 'legacy-signatory', name: p.signatoryName || FIXED_SK_CHAIRPERSON, role: p.signatoryRole || 'SK Chairperson' }]
              ).map((signatory, index) => (
                <div key={signatory.id || `letter-signatory-${index}`} className="min-w-0">
                  <div className="mb-1 h-7 border-b border-black" />
                  <p className="font-bold uppercase break-words [overflow-wrap:anywhere]">{index + 1}. {signatory.name}</p>
                  <p className="pt-0.5 text-slate-800 break-words [overflow-wrap:anywhere]">{signatory.role}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (docType === 'minutes') {
      const notesList = Array.isArray(p.timedNotes) ? p.timedNotes : [];
      const durationSec = Number(p.recordingDurationSec || 0);
      const agendaList = Array.isArray(p.agendaItems) ? p.agendaItems : [];

      return (
        <div
          style={TIMES_NEW_ROMAN_STYLE}
          className="w-full min-w-0 text-xs text-slate-900 space-y-4 [overflow-wrap:anywhere] [word-break:break-word]"
        >
          <div className="w-full min-w-0 overflow-visible">
            <SkBannerHeader formTitle="MINUTES OF MEETING" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-black py-1.5 text-[11px]">
            <span>
              Session No.: <strong>{p.sessionNo || <span className="italic text-slate-400">Session number</span>}</strong> (
              {p.sessionType || 'Regular Session'})
            </span>
            <span>
              Date: <strong>{p.sessionDate || <span className="italic text-slate-400">Date</span>}</strong> • Time:{' '}
              <strong>{p.sessionTime || <span className="italic text-slate-400">Time</span>}</strong>
            </span>
          </div>

          <div className="space-y-1 text-[11px] break-words [overflow-wrap:anywhere]">
            <p>
              <strong>Venue:</strong> {p.venue || <span className="italic text-slate-400">Meeting venue</span>}
            </p>
            <p>
              <strong>Presiding Officer:</strong> {p.presidingOfficer || <span className="italic text-slate-400">Name of presiding officer</span>}
            </p>
            <p>
              <strong>Present:</strong> {p.presentMembers || <span className="italic text-slate-400">Members present</span>}
            </p>
            <p>
              <strong>Absent:</strong> {p.absentMembers || <span className="italic text-slate-400">None / absent members</span>}
            </p>
          </div>

          <div className="space-y-1">
            <p className="font-bold uppercase underline text-[11px]">Agenda</p>
            <ol className="list-decimal list-inside space-y-0.5 text-xs leading-relaxed break-words [overflow-wrap:anywhere]">
              {agendaList.length > 0 ? agendaList.map((item, idx) => (
                <li key={`ag-view-${idx}`}>
                  {item || <span className="italic text-slate-400">Agenda item {idx + 1}</span>}
                </li>
              )) : (
                <li className="italic text-slate-400">Agenda item</li>
              )}
            </ol>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="font-bold uppercase underline text-[11px]">
                Proceedings & Recorded Notes
              </p>
              {durationSec > 0 && (
                <span className="text-[10px] text-slate-700">
                  Recorded Duration: {formatDuration(durationSec)}
                </span>
              )}
            </div>

            {p.proceedingsNotes ? (
              <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] text-xs leading-relaxed border border-black p-2.5">
                {p.proceedingsNotes}
              </div>
            ) : notesList.length > 0 ? (
              <div className="border border-black p-2.5 space-y-1 text-xs break-words [overflow-wrap:anywhere] [word-break:break-word]">
                {notesList.map((n) => (
                  <p key={n.id}>
                    <strong>[{n.elapsedLabel}]</strong> {n.text}
                  </p>
                ))}
              </div>
            ) : (
              <div className="border border-black p-3 min-h-24 text-xs text-slate-500 italic">
                <span className="text-slate-400">Enter meeting proceedings or recorded notes here.</span>
              </div>
            )}
          </div>

          <div className="pt-8 grid grid-cols-2 gap-8 text-[11px]">
            <div>
              <p>Prepared and Attested by:</p>
              <p className="mt-6 border-b border-black pb-0.5 font-bold uppercase w-56 text-center">
                {p.skSecretary || FIXED_SK_SECRETARY}
              </p>
              <p className="pt-0.5 text-center w-56">SK Secretary</p>
            </div>
            <div>
              <p>Certified Correct / Approved by:</p>
              <p className="mt-6 border-b border-black pb-0.5 font-bold uppercase w-56 text-center">
                {p.presidingOfficer || FIXED_SK_CHAIRPERSON}
              </p>
              <p className="pt-0.5 text-center w-56">
                SK Chairperson / Presiding Officer
              </p>
            </div>
          </div>
        </div>
      );
    }

    // Resolutions (Proposal & Final) modeled on uploaded SK resolution template
    const stage = p.resolutionStage || 'proposal';
    const stageBanner = stage === 'proposal' ? 'PROPOSAL COPY' : 'FINAL COPY';
    const rosterList = Array.isArray(p.resolutionPresentEntries)
      ? p.resolutionPresentEntries
      : [];
    const introList = Array.isArray(p.introducers)
      ? p.introducers
      : [];
    const whereasList =
      Array.isArray(p.whereasClauses) && p.whereasClauses.length > 0
        ? p.whereasClauses
        : [];

    return (
      <div
        style={TIMES_NEW_ROMAN_STYLE}
        className="text-[11px] text-slate-900 space-y-3 leading-snug"
      >
        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider">
          <span></span>
          <span className="border border-black px-2 py-0.5">{stageBanner}</span>
        </div>

        <div className="text-center space-y-0.5 border-b border-black pb-2">
          <p className="font-semibold">Republic of the Philippines</p>
          <p className="font-semibold">City of Cagayan de Oro</p>
          <p className="font-semibold">Province of Misamis Oriental</p>
          <p className="font-bold uppercase">Barangay Kauswagan</p>
          <p className="pt-1 font-bold uppercase underline">
            OFFICE OF THE SANGGUNIANG KABATAAN
          </p>
        </div>

        <p className="text-justify break-words [overflow-wrap:anywhere]">
          {p.sessionExcerptText || ''}
        </p>

        {/* PRESENT Roster styled after uploaded image */}
        <div className="space-y-1">
          <p className="font-bold uppercase">PRESENT:</p>
          {rosterList.length > 0 ? (
            <div className="grid grid-cols-12 gap-x-2 gap-y-0.5 pl-4 text-[11px] break-words [overflow-wrap:anywhere]">
              {rosterList.map((member, idx) => (
                <div
                  key={`roster-row-${idx}`}
                  className="col-span-12 grid grid-cols-12 items-baseline"
                >
                  <span className="col-span-3">{member.roleLabel}</span>
                  <span className="col-span-4">{member.name}</span>
                  <span className="col-span-3">{member.designation}</span>
                  <span className="col-span-2 text-right tracking-tight">
                    __________
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="pl-4 text-slate-500 italic">None listed</p>
          )}

          <p className="pt-2">
            <strong>ABSENT:</strong> {p.resolutionAbsentText || 'None'}
          </p>
        </div>

        <div className="border-t border-black pt-2 text-center space-y-1">
          <p className="text-xs font-bold uppercase">{p.resolutionNo || ''}</p>
          <p className="text-xs font-bold uppercase break-words [overflow-wrap:anywhere]">
            {p.resolutionTitle || ''}
          </p>
        </div>

        {/* INTRODUCED BY styled with up to 2 columns */}
        <div className="border-y border-black py-2">
          <p className="font-bold uppercase text-center">INTRODUCED BY:</p>
          {introList.length > 0 && (
            <div className="mt-2 grid grid-cols-2 gap-8 px-4 text-[11px]">
              {introList.map((intro, idx) => (
                <div key={`intro-col-${idx}`} className="space-y-0.5">
                  <p className="font-bold italic">{intro.name}</p>
                  <p className="text-slate-800">{intro.role}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* WHEREAS & NOW, THEREFORE clauses with bold lead-ins */}
        <div className="space-y-2.5 break-words [overflow-wrap:anywhere]">
          {whereasList.map((clause, idx) => (
            <p key={`res-wh-${idx}`} className="text-justify">
              {renderBoldLeadClause(clause, 'WHEREAS, ')}
            </p>
          ))}

          {p.nowThereforeClause && (
            <p className="text-justify pt-1">
              {renderBoldLeadClause(p.nowThereforeClause, 'NOW, THEREFORE, ')}
            </p>
          )}
        </div>

        <div className="pt-6 flex items-end justify-between gap-8 text-[11px]">
          <div>
            <p className="text-slate-600">{p.resolutionDate || ''}</p>
          </div>
          <div className="w-64">
            <p className="border-b border-black pb-0.5 font-bold uppercase">
              {p.resolutionSignatoryName || ''}
            </p>
            <p className="pt-0.5 text-slate-800">
              {p.resolutionSignatoryRole || ''}
            </p>
          </div>
        </div>
      </div>
    );
  };

  const renderRecordDocumentPreview = (rec: GovernanceDbRecord) => {
    const p = rec.payload;
    const recTab = p?.activeTab || rec.docType;
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
            ...TIMES_NEW_ROMAN_STYLE,
            width: `${widthMm}mm`,
            minHeight: `${minHeightMm}mm`,
            padding: '20mm',
          }}
          className="mx-auto bg-white text-slate-900 shadow-lg ring-1 ring-slate-900/10"
        >
          {renderPaperSheetFromPayload({
            ...p,
            activeTab: recTab,
          })}
        </div>
      </div>
    );
  };

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

      <SaveConfirmModal
        open={confirmSaveOpen}
        docLabel={currentTabMeta.label}
        recordTitle={getCurrentRecordTitle()}
        finalIdPreview={docRefNo}
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
                      Ref No.
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
                  Document Preview — {viewingRecord.title}
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
                {deletingRecord.title || deletingRecord.finalId}
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
        onChange={setActiveTab}
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
              {isRecordingNotes ? (
                <>
                  Press{' '}
                  <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-800">
                    Enter
                  </kbd>{' '}
                  to stamp
                </>
              ) : (
                <>
                  Press{' '}
                  <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-800">
                    Enter
                  </kbd>{' '}
                  to save
                </>
              )}
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
                void (async () => {
                  await loadGovernanceRecordsFromSupabase();
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
            

            <div ref={previewPanViewportRef} {...panHandlers} className={`min-w-0 overflow-auto print:overflow-visible ${isDraggingPreview ? 'cursor-grabbing select-none' : 'cursor-grab'}`} style={{ touchAction: 'none' }}>
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
                    key={`governance-preview-page-${index}`}
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
                      alt={`Governance document preview page ${index + 1}`}
                      className="block h-full w-full select-none object-fill"
                      draggable={false}
                    />
                  </div>
                )) : (
                  <div
                    className="flex w-full max-w-full flex-col items-center justify-center gap-2 bg-white px-8 text-center text-xs text-slate-500 shadow-lg ring-1 ring-slate-900/10"
                    style={{
                      width: `min(100%, ${pageWidthMm}mm)`,
                      aspectRatio: `${pageWidthMm} / ${pageMinHeightMm}`,
                    }}
                  >
                    {previewError ? (
                      <>
                        <span className="font-semibold text-rose-600">Preview failed</span>
                        <span className="max-w-full break-words">{previewError}</span>
                      </>
                    ) : (
                      <span>Preparing preview…</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div
              ref={sheetRef}
              style={{
                ...TIMES_NEW_ROMAN_STYLE,
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
              {renderPaperSheetFromPayload(buildCurrentPayload())}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
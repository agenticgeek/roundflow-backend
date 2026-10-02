export interface ActivityLogEntry {
  event: "dispatched" | "started" | "arrived" | "completed";
  timestamp: Date;
}

export interface OutstandingInvoice {
  id: string;
  invoiceNumber: string;
  amount: number;
  dueDate: Date | null;
}

export interface MobileVisitRow {
  visitId: string;
  status: string;
  price: number;
  paymentMethod: string | null;
  customerName: string;
  addressLine: string;
  postcode: string;
  roundId: string | null;
  roundName: string | null;
  serviceName: string | null;
  notes: string | null;
  issueCount: number;
  propertyNotes: { type: string; body: string }[];
  completedAt: Date | null;
  hasDebt: boolean;
  position: number | null;
}

export interface CompletionsSummary {
  revenueToday: number;
  revenueChangePercent: number | null;
  completedCount: number;
  skippedCount: number;
  totalCount: number;
  roundName: string | null;
  visits: MobileVisitRow[];
}

export interface RoundSummary {
  roundId: string;
  roundName: string;
  totalCount: number;
  completedCount: number;
  date: Date;
}

export interface ChatMessageRow {
  id: string;
  roundId: string;
  senderProfileId: string;
  body: string | null;
  type: string;
  visitId: string | null;
  createdAt: Date;
}

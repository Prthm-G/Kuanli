/** Shapes returned by the `application_tracker` RPC (migration 046). */

export type DocStatus = 'missing' | 'received' | 'verified' | 'rejected';

export interface RequiredDoc {
  docType: string;
  label: string;
  status: DocStatus;
  documentId: string | null;
}

export interface UnsortedDoc {
  documentId: string;
  createdAt: string;
  mediaUrl: string | null;
  contentText: string | null;
  contentType: string | null;
}

export interface TrackerContact {
  contactId: string;
  name: string | null;
  phone: string | null;
  rollNumber: string | null;
  university: string | null;
  stage: string;
  conversationId: string | null;
  required: RequiredDoc[];
  unsorted: UnsortedDoc[];
}

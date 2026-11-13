"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { fetchMediaAsFile } from "@/lib/payments/media-file";
import { loadStudentAccount } from "@/lib/payments/queries";
import type { FeeInstallment, FeePlan } from "@/lib/payments/types";
import { PaymentDialog } from "@/components/payments/payment-dialog";
import type { Contact, Message } from "@/types";

interface LogPaymentFromImageProps {
  /** The image message to log from; null keeps the dialog closed. */
  message: Message | null;
  contact: Contact | null;
  onClose: () => void;
}

/**
 * "Log payment" on a WhatsApp image: fetches the picture (the same way the
 * bubble does), loads the student's plan, then opens the payment dialog for the
 * chat's contact with the picture preset as the receipt. If the picture cannot
 * be fetched the dialog still opens, without a receipt, and says so.
 */
export function LogPaymentFromImage({
  message,
  contact,
  onClose,
}: LogPaymentFromImageProps) {
  const { defaultCurrency } = useAuth();
  const [ready, setReady] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [plan, setPlan] = useState<FeePlan | null>(null);
  const [installments, setInstallments] = useState<FeeInstallment[]>([]);

  // The parent keys this component on the message, so state starts fresh for each one.
  const messageId = message?.id ?? null;
  const mediaUrl = message?.media_url ?? null;
  const contactId = contact?.id ?? null;

  useEffect(() => {
    if (!messageId || !mediaUrl || !contactId) return;
    let cancelled = false;

    void (async () => {
      const supabase = createClient();
      const [file, account] = await Promise.all([
        fetchMediaAsFile(mediaUrl).catch((e: unknown) => {
          toast.warning(
            `${e instanceof Error ? e.message : "Could not load the image"}. Attach the receipt by hand.`
          );
          return null;
        }),
        loadStudentAccount(supabase, contactId).catch(() => null),
      ]);
      if (cancelled) return;
      setReceipt(file);
      setPlan(account?.plan ?? null);
      setInstallments(account?.installments ?? []);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [messageId, mediaUrl, contactId]);

  if (!message || !contact) return null;

  return (
    <PaymentDialog
      open={ready}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      contactId={contact.id}
      contactName={contact.name}
      plan={plan}
      installments={installments}
      currency={plan?.currency ?? defaultCurrency}
      initialReceipt={receipt}
      onRecorded={onClose}
    />
  );
}

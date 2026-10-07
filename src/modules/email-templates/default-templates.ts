import type { EmailTemplateKind } from '../../shared/index.ts';

/**
 * The wording the app is installed with: neutral, using only the merge fields. Admins replace it
 * on the Email templates page; the client has not given its own wording yet (OPEN_ITEMS Q14).
 */
export const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateKind, { subject: string; body: string }> =
  {
    RFQ: {
      subject: 'Request for quotation: {{insuredName}} ({{reference}})',
      body: [
        'Dear {{contactName}},',
        '',
        'Please find attached our request for quotation for {{insuredName}} for the policy period {{policyPeriod}}.',
        '',
        'We would be grateful to receive your quote by {{dueDate}}.',
        '',
        'Regards,',
        '{{senderName}}',
      ].join('\n'),
    },
    REMINDER: {
      subject: 'Reminder: request for quotation: {{insuredName}} ({{reference}})',
      body: [
        'Dear {{contactName}},',
        '',
        'This is a reminder of our request for quotation for {{insuredName}} for the policy period {{policyPeriod}}.',
        '',
        'We would be grateful to receive your quote by {{dueDate}}.',
        '',
        'Regards,',
        '{{senderName}}',
      ].join('\n'),
    },
  };

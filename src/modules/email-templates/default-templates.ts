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
    QCR: {
      subject: 'Quote comparison: {{insuredName}} ({{reference}})',
      body: [
        'Dear {{contactName}},',
        '',
        'Please find attached the comparison of the quotes we received for {{insuredName}} for the policy period {{policyPeriod}}, with our recommendation.',
        '',
        'Kindly confirm the option you would like us to place.',
        '',
        'Regards,',
        '{{senderName}}',
      ].join('\n'),
    },
    PLACEMENT_SLIP: {
      subject: 'Placement slip: {{insuredName}} ({{reference}})',
      body: [
        'Dear {{contactName}},',
        '',
        'Thank you for your quote. {{insuredName}} has accepted it for the policy period {{policyPeriod}}.',
        '',
        'Please find attached the placement slip, and kindly issue the policy / cover note as per the slip.',
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

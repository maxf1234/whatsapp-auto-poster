// Email: password resets, welcome / reminder emails and billing notices.
//
// Off until SMTP_HOST is set (any SMTP works: Gmail with an App Password,
// Brevo, Mailgun…). While it's off nothing is sent and the pages that need
// email (forgot password) say so.

export function createMailer(cfg, log = console) {
  const { host, port, user, pass, from } = cfg.smtp ?? {};
  if (!host) return { enabled: false, send: async () => false };
  let transport;
  return {
    enabled: true,
    async send({ to, subject, text }) {
      try {
        transport ??= (await import('nodemailer')).default.createTransport({
          host, port, secure: port === 465, auth: user ? { user, pass } : undefined,
        });
        await transport.sendMail({ from: from || user, to, subject, text });
        return true;
      } catch (err) {
        log.warn?.(`Email to ${to} failed: ${err.message}`);
        return false;
      }
    },
  };
}

const nodemailer = require('nodemailer');
require('dotenv').config();

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const requireTLS = String(process.env.SMTP_REQUIRE_TLS || '').toLowerCase() === 'true';
  const connectionTimeoutMs = Number(process.env.SMTP_TIMEOUT_MS || 15000);
  if (!host || !user || !pass) {
    console.warn('Email disabled: missing SMTP env (SMTP_HOST, SMTP_USER, SMTP_PASS)');
    return null;
  }
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    requireTLS,
    tls: {
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: connectionTimeoutMs,
    greetingTimeout: connectionTimeoutMs,
    socketTimeout: connectionTimeoutMs,
  });
}

async function sendMail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'onboarding@resend.dev';
  if (!process.env.MAIL_FROM && !process.env.SMTP_USER) {
    console.warn('MAIL_FROM not set. Using default sender onboarding@resend.dev');
  }

  // Prefer HTTPS provider if available to avoid SMTP port blocks
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to, subject, html, text })
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Resend ${res.status}: ${errBody}`);
      }
      const data = await res.json();
      console.log('Email sent via Resend', { to, subject, id: data && data.id });
      return true;
    } catch (err) {
      console.error('Resend send failed', { to, subject, error: err && err.message ? err.message : err });
      // fall through to SMTP as secondary
    }
  }

  const transport = createTransport();
  if (!transport) return false;
  try {
    const info = await transport.sendMail({ from, to, subject, html, text });
    console.log('Email sent via SMTP', { to, subject, messageId: info.messageId });
    return true;
  } catch (err) {
    console.error('SMTP send failed', { to, subject, error: err && err.message ? err.message : err });
    return false;
  }
}

module.exports = { sendMail };



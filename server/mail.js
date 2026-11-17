// Email for invites and password resets, sent over SMTP. Gmail works with an app password:
// SMTP_USER=you@gmail.com and SMTP_PASS=<the 16-letter app password>. Other providers can set
// SMTP_HOST and SMTP_PORT too. Without SMTP_USER and SMTP_PASS nothing is sent and admins copy the
// link themselves.
import nodemailer from 'nodemailer';

export function mailerFromEnv(env = process.env) {
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  const port = Number(env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, auth: { user, pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
  const from = env.MAIL_FROM || `"The Aquarium" <${user}>`;
  return { address: user, send: (msg) => transport.sendMail({ from, ...msg }) };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function html({ heading, lines, button, link, foot }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3efe7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3efe7;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px 28px;font-family:Arial,Helvetica,sans-serif;color:#241a0e">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:16px">${esc(heading)}</td></tr>
${lines.map((l) => `<tr><td style="font-size:16px;line-height:1.5;padding-bottom:12px">${esc(l)}</td></tr>`).join('')}
<tr><td style="padding:12px 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#d3aa5e;color:#241a0e;text-decoration:none;font-weight:bold;font-size:16px;padding:12px 22px;border-radius:8px">${esc(button)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#6b5e4e">${esc(foot)}<br>${esc(link)}</td></tr>
</table></td></tr></table></body></html>`;
}

export function inviteEmail({ link, inviter, club, name, expiresAt }) {
  const subject = `${inviter} invited you to The Aquarium`;
  const lines = [
    name ? `Hi ${name},` : 'Hi,',
    `${inviter} invited you to The Aquarium, a private poker game${club ? `, and to the club “${club}”` : ''}.`,
    'Open the link to choose a username and password.',
  ];
  const foot = `The link works once and expires on ${day(expiresAt)}. If you weren't expecting this, you can ignore it.`;
  return {
    subject,
    text: `${lines.join('\n\n')}\n\n${link}\n\n${foot}\n`,
    html: html({ heading: 'You are invited to The Aquarium', lines, button: 'Create your account', link, foot }),
  };
}

export function resetEmail({ link, admin, username, expiresAt }) {
  const subject = 'Set a new password for The Aquarium';
  const lines = [`${admin} sent you a link to set a new password for your account${username ? ` (${username})` : ''}.`];
  const foot = `The link works once and expires on ${day(expiresAt)}. Your old password keeps working until you set a new one.`;
  return {
    subject,
    text: `${lines.join('\n\n')}\n\n${link}\n\n${foot}\n`,
    html: html({ heading: subject, lines, button: 'Set a new password', link, foot }),
  };
}

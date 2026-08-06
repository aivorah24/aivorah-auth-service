const { Resend } = require('resend');
const nodemailer = require('nodemailer');

// ── Primary: Resend (noreply@aivorah.ai) ────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = 'Aivorah <noreply@aivorah.ai>';

// ── Fallback: Gmail SMTP (only if Resend not configured) ────────────────────
const gmailTransporter = (!resend && process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      pool: true, maxConnections: 3, maxMessages: 10, rateDelta: 2000, rateLimit: 5,
    })
  : null;

// Strip HTML to plain text
function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Send email (Resend primary, Gmail fallback) ─────────────────────────────
async function sendEmail({ to, subject, html, replyTo, attachments }, retries = 3) {
  const text = htmlToPlainText(html);

  // Try Resend first
  if (resend) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const { data, error } = await resend.emails.send({
          from: FROM_EMAIL,
          to,
          subject,
          html,
          text,
          ...(replyTo ? { replyTo } : {}),
          ...(attachments ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}),
        });
        if (error) throw new Error(error.message);
        console.log(`[mailer:resend] Sent to ${to} (attempt ${attempt}), id: ${data?.id}`);
        return data;
      } catch (err) {
        console.warn(`[mailer:resend] Attempt ${attempt}/${retries} failed for ${to}: ${err.message}`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        else throw err;
      }
    }
  }

  // Fallback to Gmail SMTP
  if (gmailTransporter) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const info = await gmailTransporter.sendMail({
          from: `"Aivorah" <${process.env.EMAIL_USER}>`,
          to, subject, html, text,
          replyTo: replyTo || `"Aivorah" <${process.env.EMAIL_USER}>`,
          ...(attachments ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content, encoding: 'base64', contentType: a.contentType })) } : {}),
        });
        console.log(`[mailer:gmail] Sent to ${to} (attempt ${attempt}), messageId: ${info.messageId}`);
        return info;
      } catch (err) {
        console.warn(`[mailer:gmail] Attempt ${attempt}/${retries} failed for ${to}: ${err.message}`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        else throw err;
      }
    }
  }

  console.warn(`[mailer] No email provider configured — skipping email to ${to}`);
}

// ── Email functions (templates unchanged) ───────────────────────────────────

async function sendCredentialsEmail({ to, childName, loginId, password, childEmail }) {
  if (!to) return;
  try {
    const passwordRow = password
      ? `<tr><td style="padding:8px 0;color:#888;font-size:13px">Password</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${password}</td></tr>`
      : '';

    // Only offer a "forward to child" button when this copy is going to someone
    // other than the child (i.e. the parent/teacher), and there's a password to forward.
    const canForward = password && childEmail && childEmail.toLowerCase() !== String(to).toLowerCase();
    const forwardBlock = canForward ? (() => {
      const shareText = `Hi ${childName},\n\nHere are your Aivorah login details:\n\nLogin ID: ${loginId}\nPassword: ${password}\n\nLog in at https://aivorah.ai`;
      const mailtoBody = encodeURIComponent(shareText);
      const mailtoHref = `mailto:${encodeURIComponent(childEmail)}?subject=${encodeURIComponent('Your Aivorah Login')}&body=${mailtoBody}`;
      // WhatsApp's click-to-chat URL is a plain link (no JS/Web Share API needed,
      // so it works inside any email client) — opens the app with the message
      // pre-filled, letting the parent pick who to send it to (WhatsApp, SMS via
      // the OS share sheet on mobile, etc.), not just the child's own email.
      const waHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
      return `
          <div style="text-align:center;margin:4px 0 20px">
            <a href="${mailtoHref}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;margin:0 6px 8px">
              Forward via Email
            </a>
            <a href="${waHref}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;margin:0 6px 8px">
              Share via WhatsApp
            </a>
            <p style="font-size:12px;color:#999;margin:8px 0 0">Opens your mail app or WhatsApp with the Login ID and Password pre-filled.</p>
          </div>`;
    })() : '';

    await sendEmail({
      to,
      subject: `${childName}'s Aivorah Login Details`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Student account ready</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi there!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            The student account for <strong>${childName}</strong> has been created on Aivorah.
            Here are the login credentials — please save them somewhere safe.
          </p>

          <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Login ID</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${loginId}</td></tr>
              ${passwordRow}
            </table>
          </div>
${forwardBlock}
          <p style="font-size:13px;color:#666;line-height:1.6">
            Your child can log in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a>
            using the <strong>Login ID</strong> and <strong>Password</strong> above.
            Select <em>Student</em> on the login screen.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a student account was created via Aivorah. If you didn't request this, please contact support.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendCredentialsEmail failed:', err.message);
  }
}

// One consolidated email per bulk-import batch, with a CSV attachment of every
// created student's login/password — replaces sending the teacher a separate
// email for every single row, which flooded their inbox on a large import.
async function sendBulkCredentialsEmail({ to, created }) {
  if (!to || !created || created.length === 0) return;
  try {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const roleLabel = (role) => (role === 'parent' ? 'Parent' : 'Student');

    // A bulk import creates BOTH students and their parents — the email must
    // reflect that mix, not label everyone a "student" (parents were being told
    // to log in as Student, which fails). Each row carries its own role.
    const studentCount = created.filter(r => r.role !== 'parent').length;
    const parentCount = created.filter(r => r.role === 'parent').length;

    // Human breakdown, e.g. "2 students and 2 parents" / "3 students" / "1 parent".
    const parts = [];
    if (studentCount) parts.push(`${studentCount} student${studentCount !== 1 ? 's' : ''}`);
    if (parentCount) parts.push(`${parentCount} parent${parentCount !== 1 ? 's' : ''}`);
    const breakdown = parts.join(' and ');
    const totalWord = `${created.length} account${created.length !== 1 ? 's were' : ' was'} created`;

    const csvLines = [
      'Name,Role,Login Email,Password,Grade,Curriculum',
      ...created.map(r => [r.name, roleLabel(r.role), r.email, r.password, r.grade, r.curriculum].map(esc).join(',')),
    ];
    const csvContent = csvLines.join('\n');

    // word-break lets long Login IDs / passwords WRAP inside their cell instead
    // of forcing the table wider than a phone screen (the mobile overflow bug).
    const rowsHtml = created.map(r => `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;word-break:break-word">${r.name}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:${r.role === 'parent' ? '#7C3AED' : '#0f766e'};font-weight:700">${roleLabel(r.role)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;word-break:break-all">${r.email}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;word-break:break-all">${r.password}</td>
          </tr>`).join('');

    await sendEmail({
      to,
      subject: `${created.length} login${created.length !== 1 ? 's' : ''} created — Aivorah bulk import`,
      attachments: [{
        filename: `logins_${new Date().toISOString().split('T')[0]}.csv`,
        content: Buffer.from(csvContent).toString('base64'),
        contentType: 'text/csv',
      }],
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Bulk import complete</p>
          </div>
          <p style="font-size:14px;color:#555;line-height:1.6">
            <strong>${totalWord}</strong>${breakdown ? ` (${breakdown})` : ''}. The full list is attached as a CSV — here's a quick preview:
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;table-layout:fixed">
            <colgroup>
              <col style="width:22%"><col style="width:16%"><col style="width:33%"><col style="width:29%">
            </colgroup>
            <thead>
              <tr style="background:#f5f3ff">
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Name</td>
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Role</td>
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Login ID</td>
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Password</td>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="font-size:13px;color:#666;line-height:1.6">
            Everyone logs in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a> using their Login ID and Password above — each person selects their own role on the login screen (<em>Student</em> for students, <em>Parent</em> for parents). Everyone is asked to set a new password on first sign-in.
          </p>
          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a bulk import was run on your Aivorah account.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendBulkCredentialsEmail failed:', err.message);
  }
}

async function sendVerificationEmail({ to, name, verifyUrl }) {
  if (!to) return;
  try {
    await sendEmail({
      to,
      subject: 'Verify your Aivorah account',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Confirm your email address</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name}!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Thanks for signing up! Click the button below to verify your email address and activate your Aivorah account.
          </p>

          <div style="text-align:center;margin:32px 0">
            <a href="${verifyUrl}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:0.3px">
              Verify My Email
            </a>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            If the button doesn't work, <a href="${verifyUrl}" style="color:#7C3AED">click here</a> to verify your email.
          </p>

          <p style="font-size:13px;color:#999;margin-top:24px">This link expires in 24 hours.</p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            If you didn't create an Aivorah account, you can safely ignore this email.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendVerificationEmail failed:', err.message);
  }
}

// Sends someone THEIR OWN login credentials (not a proxy/parent forwarding
// a child's) — used for parent accounts created during bulk import, where
// (unlike a student's system-generated email) the parent's own real inbox is
// the one that actually needs to receive it.
async function sendOwnAccountCredentialsEmail({ to, name, loginId, password, role }) {
  if (!to) return;
  const roleLabel = role === 'teacher' ? 'Teacher' : role === 'parent' ? 'Parent' : 'Student';
  try {
    await sendEmail({
      to,
      subject: `Your Aivorah ${roleLabel} account is ready`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">${roleLabel} account ready</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name || 'there'}!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Your Aivorah ${roleLabel} account has been created. Here are your login credentials — please save them somewhere safe.
          </p>

          <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Login ID</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${loginId}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Password</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${password}</td></tr>
            </table>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            Log in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a>
            using the <strong>Login ID</strong> and <strong>Password</strong> above. Select <em>${roleLabel}</em> on the login screen.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a ${roleLabel} account was created for you on Aivorah. If you didn't expect this, please contact support.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendOwnAccountCredentialsEmail failed:', err.message);
  }
}

async function sendWelcomeEmail({ to, name, role }) {
  if (!to) return;
  const roleLabel = role === 'teacher' ? 'Teacher' : role === 'parent' ? 'Parent' : 'Student';
  try {
    await sendEmail({
      to,
      subject: `Welcome to Aivorah, ${name}!`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Your account is ready</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name}!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Welcome to <strong>Aivorah</strong> — your ${roleLabel} account has been created successfully.
            You can now log in and complete your profile setup.
          </p>

          <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Email</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${to}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Role</td><td style="padding:8px 0;font-size:14px;color:#1a1a1a">${roleLabel}</td></tr>
            </table>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            Visit <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a> to continue setting up your account.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            If you didn't create this account, please contact support.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendWelcomeEmail failed:', err.message);
  }
}

async function sendPasswordResetEmail({ to, resetLink, childName }) {
  if (!to || !resetLink) return;
  const isChildReset = !!childName;
  const subject = isChildReset ? `Reset ${childName}'s Aivorah password` : 'Reset your Aivorah password';
  const bodyText = isChildReset
    ? `You requested a password reset for your child <strong>${childName}</strong>'s Aivorah account. Click the button below to set a new password.`
    : `We received a request to reset the password for your Aivorah account (<strong>${to}</strong>). Click the button below to set a new password.`;
  try {
    await sendEmail({
      to,
      subject,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Password Reset</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hello,</p>
          <p style="font-size:14px;color:#555;line-height:1.6">${bodyText}</p>

          <div style="text-align:center;margin:32px 0">
            <a href="${resetLink}" style="background:#7C3AED;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block">
              Reset Password
            </a>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            This link will expire in 1 hour. If you didn't request this, you can safely ignore this email.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            Aivorah · Hyderabad, India
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendPasswordResetEmail failed:', err.message);
  }
}

async function sendRecoveryOtpEmail({ to, otp }) {
  if (!to || !otp) return;
  try {
    await sendEmail({
      to,
      subject: 'Your Aivorah verification code',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Recovery Email Verification</p>
          </div>
          <p style="font-size:15px;color:#333;margin-bottom:4px">Hello,</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Use the code below to verify this email as your Aivorah account recovery email.
            This code expires in <strong>10 minutes</strong>.
          </p>
          <div style="text-align:center;margin:32px 0">
            <div style="display:inline-block;background:#f5f3ff;border:2px solid #7C3AED;border-radius:16px;padding:20px 48px">
              <span style="font-size:36px;font-weight:800;color:#7C3AED;letter-spacing:10px">${otp}</span>
            </div>
          </div>
          <p style="font-size:13px;color:#666;line-height:1.6">
            If you didn't request this, you can safely ignore this email.
          </p>
          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            Aivorah · Hyderabad, India
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendRecoveryOtpEmail failed:', err.message);
  }
}

async function sendRecoveryEmailConfirmation({ to, accountEmail, accountName }) {
  if (!to) return;
  try {
    await sendEmail({
      to,
      subject: 'Recovery email set for your Aivorah account',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Recovery Email Confirmation</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hello,</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            This email address (<strong>${to}</strong>) has been set as the <strong>recovery email</strong>
            for the Aivorah account belonging to <strong>${accountName || accountEmail}</strong>
            (${accountEmail}).
          </p>

          <div style="background:#f5f3ff;border-left:4px solid #7C3AED;border-radius:8px;padding:16px;margin:24px 0">
            <p style="margin:0;font-size:13px;color:#555;line-height:1.6">
              If you ever lose access to that account, use this email address to recover it.
              If you did not authorise this, please contact us immediately at
              <a href="mailto:aivorah24@gmail.com" style="color:#7C3AED">aivorah24@gmail.com</a>.
            </p>
          </div>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            Aivorah · Hyderabad, India
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendRecoveryEmailConfirmation failed:', err.message);
  }
}

// ── Contact / careers form submission ───────────────────────────────────────
// Delivers a website contact-form message to the Aivorah inbox. The visitor's
// email is set as Reply-To so the team can reply directly from their inbox.
async function sendContactEmail({ name, email, message, topic }) {
  const inbox = process.env.CONTACT_INBOX || process.env.EMAIL_USER || 'aivorah24@gmail.com';
  const safe = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const data = await sendEmail({
    to: inbox,
    replyTo: email ? `"${String(name || '').replace(/"/g, '')}" <${email}>` : undefined,
    subject: `New ${topic || 'Contact'} message from ${name || 'website visitor'}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff">
        <div style="background:#7C3AED;border-radius:12px;padding:20px 24px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">Aivorah</h1>
          <p style="margin:6px 0 0;color:#e9d5ff;font-size:13px">New ${safe(topic) || 'contact'} message from the website</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333">
          <tr><td style="padding:6px 0;color:#888;width:90px">Name</td><td style="padding:6px 0">${safe(name)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Email</td><td style="padding:6px 0"><a href="mailto:${safe(email)}" style="color:#7C3AED">${safe(email)}</a></td></tr>
          ${topic ? `<tr><td style="padding:6px 0;color:#888">Topic</td><td style="padding:6px 0">${safe(topic)}</td></tr>` : ''}
        </table>
        <div style="background:#f7f7f7;border-radius:10px;padding:16px;margin-top:16px;white-space:pre-wrap;line-height:1.6;color:#222">${safe(message)}</div>
        <p style="font-size:12px;color:#aaa;margin-top:24px;border-top:1px solid #eee;padding-top:12px">
          Reply directly to this email to respond to ${safe(name) || 'the sender'}.
        </p>
      </div>
    `,
  });
  return data;
}

// ── Demo request: notify the founder with a secure confirm link ──────────────
async function sendDemoRequestToFounder({ inbox, req, confirmUrl }) {
  const to = inbox || process.env.CONTACT_INBOX || process.env.EMAIL_USER || 'aivorah24@gmail.com';
  const safe = (s) => String(s || '—').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#888;width:140px;vertical-align:top">${k}</td><td style="padding:6px 0;color:#222">${safe(v)}</td></tr>`;
  return sendEmail({
    to,
    replyTo: req.email ? `"${String(req.name || '').replace(/"/g, '')}" <${req.email}>` : undefined,
    subject: `New demo request — ${req.name || 'Unknown'}${req.school ? ' · ' + req.school : ''}`,
    html: `
      <div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:24px;background:#fff">
        <div style="background:#7C3AED;border-radius:12px;padding:20px 24px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">Aivorah</h1>
          <p style="margin:6px 0 0;color:#e9d5ff;font-size:13px">New demo request</p>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${row('Name', req.name)}
          ${row('Email', req.email)}
          ${row('School / org', req.school)}
          ${row('Role', req.role)}
          ${row('No. of students', req.team_size)}
          ${row('Preferred times', req.preferred_times)}
        </table>
        ${req.message ? `<div style="background:#f7f7f7;border-radius:10px;padding:14px;margin-top:14px;white-space:pre-wrap;line-height:1.6;color:#222">${safe(req.message)}</div>` : ''}
        <div style="text-align:center;margin:28px 0 8px">
          <a href="${confirmUrl}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:13px 30px;border-radius:10px;font-size:15px;font-weight:700">
            Review &amp; confirm a time
          </a>
        </div>
        <p style="font-size:12px;color:#aaa;text-align:center;margin-top:8px">
          Opening this link lets you set the meeting time and send the visitor a Google Meet invite.
        </p>
      </div>
    `,
  });
}

// ── Demo confirmation: send the visitor their Meet invite ────────────────────
async function sendDemoConfirmation({ to, name, whenText, meetLink, founderEmail, icsContent }) {
  if (!to) return;
  const safe = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attachments = icsContent
    ? [{ filename: 'aivorah-demo.ics', content: Buffer.from(icsContent).toString('base64'), contentType: 'text/calendar' }]
    : undefined;
  return sendEmail({
    to,
    replyTo: founderEmail ? `"Aivorah" <${founderEmail}>` : undefined,
    subject: 'Your Aivorah demo is confirmed',
    attachments,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff">
        <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
          <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Your demo is confirmed</p>
        </div>
        <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${safe(name) || 'there'},</p>
        <p style="font-size:14px;color:#555;line-height:1.6">
          Thank you for your interest in Aivorah. We're looking forward to showing you around. Here are your demo details:
        </p>
        <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
          <p style="margin:0 0 10px;font-size:14px;color:#333"><strong>When:</strong> ${safe(whenText)}</p>
          ${meetLink ? `<p style="margin:0;font-size:14px;color:#333"><strong>Join:</strong> <a href="${meetLink}" style="color:#7C3AED">${safe(meetLink)}</a></p>` : ''}
        </div>
        ${meetLink ? `<div style="text-align:center;margin:24px 0">
          <a href="${meetLink}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:15px;font-weight:700">Join Google Meet</a>
        </div>` : ''}
        <p style="font-size:13px;color:#666;line-height:1.6">
          A calendar invite is attached. If you need to reschedule, just reply to this email.
        </p>
        <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
          Aivorah · Hyderabad, India
        </p>
      </div>
    `,
  });
}

// ── Generic email verification OTP (e.g. verifying a child's email) ──────────
async function sendEmailOtpCode({ to, otp, name }) {
  if (!to || !otp) return;
  return sendEmail({
    to,
    subject: 'Your Aivorah verification code',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
        <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
          <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Verify your email</p>
        </div>
        <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name || 'there'},</p>
        <p style="font-size:14px;color:#555;line-height:1.6">
          Enter the code below to verify this email address on Aivorah. This code expires in <strong>10 minutes</strong>.
        </p>
        <div style="text-align:center;margin:32px 0">
          <div style="display:inline-block;background:#f5f3ff;border:2px solid #7C3AED;border-radius:16px;padding:20px 48px">
            <span style="font-size:36px;font-weight:800;color:#7C3AED;letter-spacing:10px">${otp}</span>
          </div>
        </div>
        <p style="font-size:13px;color:#666;line-height:1.6">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

// ── B2C → B2B Conversion Welcome Email (Professional Verbiage) ───────────────
async function sendB2BConversionWelcomeEmail({ to, name, role, schoolName, studentName, grade, section }) {
  if (!to) return;
  const safe = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isParent = role === 'parent';
  const targetName = safe(name || (isParent ? 'Parent' : 'Student'));
  const school = safe(schoolName || 'Your School');
  const child = safe(studentName || 'your child');
  const classInfo = [grade, section].filter(Boolean).join(' - ');

  const subject = isParent
    ? `Welcome to ${school} on Aivorah — Parent Portal Activated`
    : `Welcome to ${school} on Aivorah — Student Portal Activated`;

  const leadText = isParent
    ? `We are pleased to inform you that ${child ? `<strong>${child}</strong>'s` : 'your child\'s'} profile has been officially verified and linked to <strong>${school}</strong>${classInfo ? ` (${classInfo})` : ''} on the Aivorah digital ecosystem.`
    : `We are pleased to inform you that your student account has been officially verified and linked to <strong>${school}</strong>${classInfo ? ` (${classInfo})` : ''} on the Aivorah digital ecosystem.`;

  const capabilitiesList = isParent
    ? `
      <ul style="padding-left:20px;color:#444;font-size:14px;line-height:1.8;margin:12px 0">
        <li><strong>Real-Time Attendance & Schedule Tracking:</strong> Monitor daily class timetables and live attendance status.</li>
        <li><strong>Teacher Feedback & Gradebook Insights:</strong> Review assignments, quizzes, and personalized academic evaluations.</li>
        <li><strong>Official School Communication:</strong> Receive verified announcements, circulars, and direct teacher correspondence.</li>
        <li><strong>Curriculum-Aligned AI Oversight:</strong> Review your child's learning progression across structured grade milestones.</li>
      </ul>`
    : `
      <ul style="padding-left:20px;color:#444;font-size:14px;line-height:1.8;margin:12px 0">
        <li><strong>Official School Timetable:</strong> Access your live daily schedule, homeroom periods, and class meeting links.</li>
        <li><strong>Teacher-Assigned Challenges & Worksheets:</strong> Complete grade-scoped assignments directly within your portal.</li>
        <li><strong>Class Leaderboard & Analytics:</strong> Track your academic standing and topic mastery alongside your peers.</li>
        <li><strong>Curriculum-Aligned AI Study Companion:</strong> Get 24/7 personalized tutoring synced to your exact school syllabus.</li>
      </ul>`;

  return sendEmail({
    to,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:28px;background:#fff;border:1px solid #eaeaea;border-radius:12px">
        <div style="background:#1E293B;border-radius:10px;padding:24px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
          <p style="margin:6px 0 0;color:#94A3B8;font-size:13px">Official School Network Connection · ${school}</p>
        </div>
        <p style="font-size:15px;color:#1E293B;margin-bottom:12px">Dear ${targetName},</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin-top:0">${leadText}</p>
        
        <div style="background:#F8FAFC;border-left:4px solid #3B82F6;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0">
          <h3 style="margin:0 0 8px;font-size:14px;color:#1E293B;text-transform:uppercase;letter-spacing:0.5px">Your New B2B Capabilities</h3>
          ${capabilitiesList}
        </div>

        <p style="font-size:14px;color:#475569;line-height:1.6">
          You may log in at any time to explore your connected dashboard. All existing study history has been seamlessly preserved.
        </p>
        <div style="text-align:center;margin:28px 0">
          <a href="https://aivorah.ai" style="display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:14px;font-weight:600">Access School Portal</a>
        </div>
        <p style="font-size:12px;color:#94A3B8;margin-top:32px;border-top:1px solid #F1F5F9;padding-top:16px">
          ${school} · Powered by Aivorah Digital Learning Infrastructure
        </p>
      </div>
    `,
  });
}

module.exports = { sendCredentialsEmail, sendBulkCredentialsEmail, sendOwnAccountCredentialsEmail, sendWelcomeEmail, sendVerificationEmail, sendPasswordResetEmail, sendRecoveryEmailConfirmation, sendRecoveryOtpEmail, sendContactEmail, sendDemoRequestToFounder, sendDemoConfirmation, sendEmailOtpCode, sendB2BConversionWelcomeEmail };

import { Router } from "express";
import nodemailer from "nodemailer";
import { logger } from "../lib/logger";

const router = Router();

router.post("/", async (req, res) => {
  const { name, email, subject, message } = req.body as {
    name?: string;
    email?: string;
    subject?: string;
    message?: string;
  };

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: "Name, email, and message are required." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  const fromEmail = process.env["CONTACT_FROM_EMAIL"];
  const fromPassword = process.env["CONTACT_FROM_PASSWORD"];
  const toEmail = process.env["CONTACT_TO_EMAIL"];

  if (!fromEmail || !fromPassword || !toEmail) {
    logger.warn("Contact email env vars not configured — logging submission only");
    logger.info({ name, email, subject, message }, "Contact form submission (email not sent)");
    return res.json({ ok: true, note: "received" });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: fromEmail, pass: fromPassword },
    });

    await transporter.sendMail({
      from: `"VallartaPulse Contact" <${fromEmail}>`,
      to: toEmail,
      replyTo: email,
      subject: `VallartaPulse: ${subject?.trim() || "New message"}`,
      text: `From: ${name} <${email}>\n\n${message}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#00C2A8;margin-bottom:4px">VallartaPulse Contact</h2>
          <hr style="border:none;border-top:1px solid #ddd;margin-bottom:20px"/>
          <p><strong>From:</strong> ${name} &lt;${email}&gt;</p>
          <p><strong>Subject:</strong> ${subject?.trim() || "(none)"}</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:16px 0"/>
          <p style="white-space:pre-wrap">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
        </div>
      `,
    });

    logger.info({ name, email, subject }, "Contact form email sent");
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to send contact email");
    return res.status(500).json({ error: "Failed to send message. Please try again later." });
  }
});

export default router;

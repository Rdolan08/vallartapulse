import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { getApiBase } from "@/lib/api";
import { useState } from "react";

type Status = "idle" | "sending" | "success" | "error";

export default function Contact() {
  const { t } = useLanguage();
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");

    try {
      const res = await fetch(`${getApiBase()}/api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || t("Something went wrong. Please try again.", "Algo salió mal. Por favor intenta de nuevo."));
        setStatus("error");
      } else {
        setStatus("success");
        setForm({ name: "", email: "", subject: "", message: "" });
      }
    } catch {
      setErrorMsg(t("Unable to send your message. Please try again later.", "No se pudo enviar tu mensaje. Por favor intenta más tarde."));
      setStatus("error");
    }
  };

  const inputStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "rgba(245,247,250,0.9)",
    borderRadius: "10px",
    padding: "10px 14px",
    fontSize: "14px",
    width: "100%",
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "12px",
    fontWeight: 500,
    color: "rgba(154,165,177,0.7)",
    marginBottom: "6px",
    letterSpacing: "0.02em",
  };

  return (
    <PageWrapper>
      <div className="max-w-xl mx-auto py-10 px-4">

        <h1 className="text-3xl font-bold mb-1" style={{ color: "rgba(245,247,250,0.95)" }}>
          {t("Contact Us", "Contáctanos")}
        </h1>
        <p className="text-sm mb-10" style={{ color: "rgba(154,165,177,0.6)" }}>
          {t(
            "Have a question, suggestion, or data request? We'd love to hear from you.",
            "¿Tienes una pregunta, sugerencia o solicitud de datos? Nos encantaría escucharte."
          )}
        </p>

        {status === "success" ? (
          <div
            className="rounded-2xl p-8 text-center"
            style={{ background: "rgba(0,194,168,0.08)", border: "1px solid rgba(0,194,168,0.25)" }}
          >
            <div className="text-3xl mb-3">✓</div>
            <h2 className="text-lg font-semibold mb-2" style={{ color: "#00C2A8" }}>
              {t("Message received", "Mensaje recibido")}
            </h2>
            <p className="text-sm" style={{ color: "rgba(154,165,177,0.7)" }}>
              {t(
                "Thanks for reaching out. We'll get back to you as soon as we can.",
                "Gracias por comunicarte. Te responderemos a la brevedad posible."
              )}
            </p>
            <button
              onClick={() => setStatus("idle")}
              className="mt-6 text-sm underline"
              style={{ color: "rgba(154,165,177,0.5)" }}
            >
              {t("Send another message", "Enviar otro mensaje")}
            </button>
          </div>
        ) : (
          <div
            className="rounded-2xl p-8"
            style={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <form onSubmit={handleSubmit} className="space-y-5">

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label style={labelStyle}>
                    {t("Your name", "Tu nombre")} <span style={{ color: "#00C2A8" }}>*</span>
                  </label>
                  <input
                    name="name"
                    value={form.name}
                    onChange={handleChange}
                    placeholder={t("Jane Smith", "Juan García")}
                    required
                    style={inputStyle}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(0,194,168,0.5)")}
                    onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    {t("Your email", "Tu correo")} <span style={{ color: "#00C2A8" }}>*</span>
                  </label>
                  <input
                    name="email"
                    type="email"
                    value={form.email}
                    onChange={handleChange}
                    placeholder="jane@example.com"
                    required
                    style={inputStyle}
                    onFocus={(e) => (e.target.style.borderColor = "rgba(0,194,168,0.5)")}
                    onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                  />
                </div>
              </div>

              <div>
                <label style={labelStyle}>{t("Subject", "Asunto")}</label>
                <select
                  name="subject"
                  value={form.subject}
                  onChange={handleChange}
                  style={{ ...inputStyle, cursor: "pointer" }}
                >
                  <option value="">{t("Select a topic...", "Selecciona un tema...")}</option>
                  <option value="General question">{t("General question", "Pregunta general")}</option>
                  <option value="Data request">{t("Data request or suggestion", "Solicitud o sugerencia de datos")}</option>
                  <option value="Pricing tool feedback">{t("Pricing tool feedback", "Comentarios sobre la herramienta de precios")}</option>
                  <option value="Bug or issue">{t("Bug or issue", "Error o problema técnico")}</option>
                  <option value="Partnership">{t("Partnership inquiry", "Consulta de colaboración")}</option>
                  <option value="Other">{t("Other", "Otro")}</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>
                  {t("Message", "Mensaje")} <span style={{ color: "#00C2A8" }}>*</span>
                </label>
                <textarea
                  name="message"
                  value={form.message}
                  onChange={handleChange}
                  placeholder={t("Tell us what's on your mind...", "Cuéntanos qué tienes en mente...")}
                  required
                  rows={6}
                  style={{ ...inputStyle, resize: "vertical" }}
                  onFocus={(e) => (e.target.style.borderColor = "rgba(0,194,168,0.5)")}
                  onBlur={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
                />
              </div>

              {status === "error" && (
                <p className="text-sm" style={{ color: "#f87171" }}>{errorMsg}</p>
              )}

              <button
                type="submit"
                disabled={status === "sending"}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity"
                style={{
                  background: status === "sending" ? "rgba(0,194,168,0.5)" : "#00C2A8",
                  color: "#0A1E27",
                  opacity: status === "sending" ? 0.7 : 1,
                  cursor: status === "sending" ? "not-allowed" : "pointer",
                }}
              >
                {status === "sending" ? t("Sending…", "Enviando…") : t("Send Message", "Enviar Mensaje")}
              </button>

            </form>
          </div>
        )}

      </div>
    </PageWrapper>
  );
}

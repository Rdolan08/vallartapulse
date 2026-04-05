import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import founderPhoto from "@assets/60F21D23-B299-493B-AB91-0FC4E4DD5DA1_1775158046764.png";

const CARD_STYLE = { background: "#163C4A", border: "1px solid rgba(255,255,255,0.06)" };
const LABEL_STYLE = { color: "rgba(154,165,177,0.45)" };
const BODY_STYLE = { color: "rgba(154,165,177,0.75)" };
const HEADING_STYLE = { color: "rgba(245,247,250,0.95)" };

export default function About() {
  const { t } = useLanguage();

  return (
    <PageWrapper>
      <div className="max-w-2xl mx-auto py-10 px-4 space-y-6">

        <div>
          <h1 className="text-3xl font-bold mb-1" style={HEADING_STYLE}>
            {t("About VallartaPulse", "Acerca de VallartaPulse")}
          </h1>
          <p className="text-sm" style={{ color: "rgba(154,165,177,0.6)" }}>
            {t(
              "Puerto Vallarta's market intelligence platform for property owners, managers, and investors.",
              "La plataforma de inteligencia de mercado de Puerto Vallarta para propietarios, administradores e inversores."
            )}
          </p>
        </div>

        {/* Founder card */}
        <div className="rounded-2xl p-8" style={CARD_STYLE}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] mb-5" style={LABEL_STYLE}>
            {t("Founder", "Fundador")}
          </p>

          <div className="flex items-start gap-6 mb-6">
            <img
              src={founderPhoto}
              alt="Ryan Dolan"
              className="rounded-xl object-cover flex-shrink-0"
              style={{ width: "120px", height: "120px", objectPosition: "center top" }}
            />
            <div>
              <h2 className="text-xl font-semibold mb-0.5" style={HEADING_STYLE}>Ryan Dolan</h2>
              <p className="text-sm mb-3" style={{ color: "#00C2A8" }}>
                {t("Founder, VallartaPulse", "Fundador, VallartaPulse")}
              </p>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.7)" }}>
                {t("Owner at ", "Propietario en ")}
                <span style={{ color: "rgba(245,247,250,0.85)", fontWeight: 500 }}>Ciye</span>
                {t(
                  ", an upcoming development on Lázaro Cárdenas Park in Puerto Vallarta's Zona Romántica.",
                  ", un desarrollo próximo en el Parque Lázaro Cárdenas en la Zona Romántica de Puerto Vallarta."
                )}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm leading-relaxed" style={BODY_STYLE}>
            <p>
              {t(
                "After more than 20 years working in AI, data, and technology — including leadership roles within the U.S. federal government — Ryan set out to build something more practical and closer to home. VallartaPulse is that vision: a market intelligence platform that brings together rental pricing, tourism flows, economic indicators, safety data, and climate patterns for Puerto Vallarta's rapidly growing property market.",
                "Tras más de 20 años trabajando en inteligencia artificial, datos y tecnología — incluyendo roles de liderazgo en el gobierno federal de Estados Unidos — Ryan decidió construir algo más práctico y cercano a casa. VallartaPulse es esa visión: una plataforma de inteligencia de mercado que integra precios de renta, flujos turísticos, indicadores económicos, datos de seguridad y clima para el mercado inmobiliario de Puerto Vallarta."
              )}
            </p>
            <p>
              {t(
                "As both a property owner and frequent resident, Ryan is building VallartaPulse from the perspective of someone actively investing in the area, not just analyzing it from the outside.",
                "Como propietario y residente frecuente, Ryan construye VallartaPulse desde la perspectiva de alguien que invierte activamente en la zona, no solo la analiza desde afuera."
              )}
            </p>
            <p>
              {t(
                "A longtime sports fan with a strong interest in analytics, Ryan closely follows a range of teams and leagues, with a particular passion for FC Bayern Munich — where performance, data, and strategy all come together at the highest level.",
                "Fanático del deporte con un profundo interés en el análisis, Ryan sigue de cerca a varios equipos y ligas, con especial pasión por el FC Bayern Múnich — donde el rendimiento, los datos y la estrategia se unen al más alto nivel."
              )}
            </p>
            <p>
              {t(
                "He lives in Minneapolis with his husband, Chris, and their daughter, Olivia, and splits his time between the U.S. and Puerto Vallarta. When he's not working on VallartaPulse, he's likely following a game, exploring, or thinking about how to turn better data into better decisions.",
                "Vive en Minneapolis con su esposo, Chris, y su hija, Olivia, y divide su tiempo entre Estados Unidos y Puerto Vallarta. Cuando no está trabajando en VallartaPulse, probablemente esté viendo un partido, explorando, o pensando en cómo convertir mejores datos en mejores decisiones."
              )}
            </p>
          </div>
        </div>

        {/* Mission card */}
        <div className="rounded-2xl p-8" style={CARD_STYLE}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] mb-4" style={LABEL_STYLE}>
            {t("The Mission", "La Misión")}
          </p>
          <div className="space-y-4 text-sm leading-relaxed" style={BODY_STYLE}>
            <p>
              {t(
                "Puerto Vallarta property owners have been pricing blind. Generic national tools don't know that Amapas commands a view premium, that Versalles outperforms its price tier in shoulder season, or that cruise arrivals spike occupancy in the Romantic Zone on specific days. VallartaPulse exists to fix that.",
                "Los propietarios en Puerto Vallarta han estado fijando precios a ciegas. Las herramientas genéricas nacionales no saben que Amapas tiene una prima por vista, que Versalles supera su rango de precios en temporada intermedia, o que las llegadas de cruceros disparan la ocupación en la Zona Romántica en días específicos. VallartaPulse existe para cambiar eso."
              )}
            </p>
            <p>
              {t(
                "The platform gives owners access to hyper-local economic data, neighborhood-level market signals, and truly comparable rental properties — so they can price dynamically with far more precision than any national tool allows.",
                "La plataforma da a los propietarios acceso a datos económicos hiperlocales, señales de mercado por colonia y propiedades de renta verdaderamente comparables — para que puedan fijar precios de forma dinámica con mucha más precisión que cualquier herramienta nacional."
              )}
            </p>
          </div>
        </div>

        {/* Roadmap card */}
        <div className="rounded-2xl p-8" style={CARD_STYLE}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] mb-4" style={LABEL_STYLE}>
            {t("What We're Building", "Lo Que Estamos Construyendo")}
          </p>
          <div className="space-y-5 text-sm" style={BODY_STYLE}>

            <div className="flex gap-4">
              <div className="flex-shrink-0 mt-0.5">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "#00C2A8", color: "#0A1E27" }}>1</div>
              </div>
              <div>
                <p className="font-semibold mb-1" style={HEADING_STYLE}>
                  {t("Data & Pricing", "Datos y Precios")}
                  <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 rounded" style={{ background: "rgba(0,194,168,0.15)", color: "#00C2A8" }}>
                    {t("Live now", "Disponible ahora")}
                  </span>
                </p>
                <p className="leading-relaxed">
                  {t(
                    "Neighborhood comps, tourism flows, seasonality layers, airport traffic, cruise schedules, economic indicators, safety data, and climate patterns — all aggregated into a single pricing tool built for PV.",
                    "Comparables por colonia, flujos turísticos, capas de temporalidad, tráfico aeroportuario, itinerarios de cruceros, indicadores económicos, datos de seguridad y clima — todo integrado en una sola herramienta de precios diseñada para PV."
                  )}
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="flex-shrink-0 mt-0.5">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "rgba(99,102,241,0.25)", color: "#6366F1", border: "1px solid rgba(99,102,241,0.4)" }}>2</div>
              </div>
              <div>
                <p className="font-semibold mb-1" style={HEADING_STYLE}>
                  {t("Owner Toolkit", "Herramientas para Propietarios")}
                </p>
                <p className="leading-relaxed">
                  {t(
                    "Calendar integration, budgeting tools, and operational planning support — so owners can move from better data to better day-to-day decisions.",
                    "Integración de calendario, herramientas de presupuesto y planificación operativa — para que los propietarios puedan pasar de mejores datos a mejores decisiones cotidianas."
                  )}
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="flex-shrink-0 mt-0.5">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "rgba(99,102,241,0.25)", color: "#6366F1", border: "1px solid rgba(99,102,241,0.4)" }}>3</div>
              </div>
              <div>
                <p className="font-semibold mb-1" style={HEADING_STYLE}>
                  {t("Owner Community & Marketplace", "Comunidad y Directorio de Proveedores")}
                </p>
                <p className="leading-relaxed">
                  {t(
                    "A blog and community where owners share insights and experiences, followed by a vetted vendor marketplace — plumbers, electricians, cleaners, property managers, and more — with transparent ratings from owners who've actually hired them. For remote owners managing from thousands of miles away, trusted local referrals are a real need.",
                    "Un blog y comunidad donde los propietarios comparten experiencias y consejos, seguido de un directorio de proveedores verificados — plomeros, electricistas, personal de limpieza, administradores y más — con calificaciones transparentes de propietarios que los han contratado. Para quienes gestionan desde lejos, las referencias locales confiables son una necesidad real."
                  )}
                </p>
              </div>
            </div>

          </div>
        </div>

        {/* Vision footer */}
        <div className="rounded-2xl p-8" style={CARD_STYLE}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] mb-4" style={LABEL_STYLE}>
            {t("The Vision", "La Visión")}
          </p>
          <p className="text-sm leading-relaxed" style={BODY_STYLE}>
            {t(
              "VallartaPulse is being built to become the operating system for Puerto Vallarta property owners — first for data-driven pricing, then for smarter ownership, and ultimately for trusted local connection.",
              "VallartaPulse está siendo construido para convertirse en el sistema operativo de los propietarios de Puerto Vallarta — primero para la fijación de precios basada en datos, luego para una gestión más inteligente, y finalmente para una conexión local de confianza."
            )}
          </p>
        </div>

      </div>
    </PageWrapper>
  );
}

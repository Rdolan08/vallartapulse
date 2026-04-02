import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import founderPhoto from "@assets/60F21D23-B299-493B-AB91-0FC4E4DD5DA1_1775158046764.png";

export default function About() {
  const { t } = useLanguage();

  return (
    <PageWrapper>
      <div className="max-w-2xl mx-auto py-10 px-4">

        <h1 className="text-3xl font-bold mb-1" style={{ color: "rgba(245,247,250,0.95)" }}>
          {t("About VallartaPulse", "Acerca de VallartaPulse")}
        </h1>
        <p className="text-sm mb-10" style={{ color: "rgba(154,165,177,0.6)" }}>
          {t(
            "A smarter, data-driven view of Puerto Vallarta's rental market.",
            "Una visión más inteligente y basada en datos del mercado de renta en Puerto Vallarta."
          )}
        </p>

        {/* Founder card */}
        <div
          className="rounded-2xl p-8 mb-8"
          style={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.14em] mb-5"
            style={{ color: "rgba(154,165,177,0.45)" }}
          >
            {t("Founder", "Fundador")}
          </p>

          <div className="flex items-start gap-6 mb-6">
            <img
              src={founderPhoto}
              alt="Ryan Dolan"
              className="rounded-xl object-cover flex-shrink-0"
              style={{ width: "88px", height: "88px", objectPosition: "center top" }}
            />
            <div>
              <h2 className="text-xl font-semibold mb-0.5" style={{ color: "rgba(245,247,250,0.95)" }}>
                Ryan Dolan
              </h2>
              <p className="text-sm mb-3" style={{ color: "#00C2A8" }}>
                {t("Founder, VallartaPulse", "Fundador, VallartaPulse")}
              </p>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.7)" }}>
                {t(
                  "Owner at ",
                  "Propietario en "
                )}
                <span style={{ color: "rgba(245,247,250,0.85)", fontWeight: 500 }}>Ciye</span>
                {t(
                  ", an upcoming development on Lázaro Cárdenas Park in Puerto Vallarta's Zona Romántica.",
                  ", un desarrollo próximo en el Parque Lázaro Cárdenas en la Zona Romántica de Puerto Vallarta."
                )}
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.75)" }}>
            <p>
              {t(
                "After more than 20 years working in AI, data, and technology — including leadership roles within the U.S. federal government — Ryan set out to build something more practical and closer to home. Vallarta Pulse is that vision: a smarter, data-driven way to understand pricing, demand, and opportunity in Puerto Vallarta's rapidly growing rental market.",
                "Tras más de 20 años trabajando en inteligencia artificial, datos y tecnología — incluyendo roles de liderazgo en el gobierno federal de Estados Unidos — Ryan decidió construir algo más práctico y cercano a casa. Vallarta Pulse es esa visión: una forma más inteligente y basada en datos de entender precios, demanda y oportunidades en el mercado de renta de Puerto Vallarta."
              )}
            </p>
            <p>
              {t(
                "As both a property owner and frequent resident, Ryan is building Vallarta Pulse from the perspective of someone actively investing in the area, not just analyzing it from the outside.",
                "Como propietario y residente frecuente, Ryan construye Vallarta Pulse desde la perspectiva de alguien que invierte activamente en la zona, no solo la analiza desde afuera."
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
                "He lives in Minneapolis with his husband, Chris, and their daughter, Olivia, and splits his time between the U.S. and Puerto Vallarta. When he's not working on Vallarta Pulse, he's likely following a game, exploring, or thinking about how to turn better data into better decisions.",
                "Vive en Minneapolis con su esposo, Chris, y su hija, Olivia, y divide su tiempo entre Estados Unidos y Puerto Vallarta. Cuando no está trabajando en Vallarta Pulse, probablemente esté viendo un partido, explorando, o pensando en cómo convertir mejores datos en mejores decisiones."
              )}
            </p>
          </div>
        </div>

        {/* Platform blurb */}
        <div
          className="rounded-2xl p-8"
          style={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.14em] mb-4"
            style={{ color: "rgba(154,165,177,0.45)" }}
          >
            {t("The Platform", "La Plataforma")}
          </p>
          <div className="space-y-4 text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.75)" }}>
            <p>
              {t(
                "VallartaPulse aggregates data from Airbnb, VRBO, Booking.com, DATATUR, SECTUR, Banxico, and local agencies to give property managers and rental owners a clear, unbiased picture of the market — pricing comps, seasonality layers, neighborhood benchmarks, tourism trends, economic indicators, and more.",
                "VallartaPulse agrega datos de Airbnb, VRBO, Booking.com, DATATUR, SECTUR, Banxico y agencias locales para ofrecer a propietarios y administradores una visión clara e imparcial del mercado — comparaciones de precios, capas de temporalidad, referencias por colonia, tendencias turísticas, indicadores económicos y más."
              )}
            </p>
            <p>
              {t(
                "The platform is bilingual (English / Español) and built specifically for the greater Bahía de Banderas region, covering Puerto Vallarta, Nuevo Vallarta, Bucerias, Punta Mita, and surrounding areas.",
                "La plataforma es bilingüe (English / Español) y está desarrollada específicamente para la región de la Bahía de Banderas, cubriendo Puerto Vallarta, Nuevo Vallarta, Bucerías, Punta Mita y zonas circundantes."
              )}
            </p>
          </div>
        </div>

      </div>
    </PageWrapper>
  );
}

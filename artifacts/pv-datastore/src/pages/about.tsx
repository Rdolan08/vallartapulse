import { PageWrapper } from "@/components/layout/page-wrapper";
import founderPhoto from "@assets/60F21D23-B299-493B-AB91-0FC4E4DD5DA1_1775158046764.png";

export default function About() {
  return (
    <PageWrapper>
      <div className="max-w-2xl mx-auto py-10 px-4">

        <h1 className="text-3xl font-bold mb-1" style={{ color: "rgba(245,247,250,0.95)" }}>
          About VallartaPulse
        </h1>
        <p className="text-sm mb-10" style={{ color: "rgba(154,165,177,0.6)" }}>
          A smarter, data-driven view of Puerto Vallarta's rental market.
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
            Founder
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
                Founder, VallartaPulse
              </p>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.7)" }}>
                Owner at{" "}
                <span style={{ color: "rgba(245,247,250,0.85)", fontWeight: 500 }}>Ciye</span>
                , an upcoming development on Lázaro Cárdenas Park in Puerto Vallarta's Zona Romántica.
              </p>
            </div>
          </div>

          <div className="space-y-4 text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.75)" }}>
            <p>
              After more than 20 years working in AI, data, and technology — including leadership roles
              within the U.S. federal government — Ryan set out to build something more practical and
              closer to home. Vallarta Pulse is that vision: a smarter, data-driven way to understand
              pricing, demand, and opportunity in Puerto Vallarta's rapidly growing rental market.
            </p>
            <p>
              As both a property owner and frequent resident, Ryan is building Vallarta Pulse from the
              perspective of someone actively investing in the area, not just analyzing it from the outside.
            </p>
            <p>
              A longtime sports fan with a strong interest in analytics, Ryan closely follows a range
              of teams and leagues, with a particular passion for FC Bayern Munich — where performance,
              data, and strategy all come together at the highest level.
            </p>
            <p>
              He lives in Minneapolis with his husband, Chris, and their daughter, Olivia, and splits
              his time between the U.S. and Puerto Vallarta. When he's not working on Vallarta Pulse,
              he's likely following a game, exploring, or thinking about how to turn better data into
              better decisions.
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
            The Platform
          </p>
          <div className="space-y-4 text-sm leading-relaxed" style={{ color: "rgba(154,165,177,0.75)" }}>
            <p>
              VallartaPulse aggregates data from Airbnb, VRBO, Booking.com, DATATUR, SECTUR, Banxico,
              and local agencies to give property managers and rental owners a clear, unbiased picture
              of the market — pricing comps, seasonality layers, neighborhood benchmarks, tourism
              trends, economic indicators, and more.
            </p>
            <p>
              The platform is bilingual (English / Español) and built specifically for the greater
              Bahía de Banderas region, covering Puerto Vallarta, Nuevo Vallarta, Bucerias, Punta
              Mita, and surrounding areas.
            </p>
          </div>
        </div>

      </div>
    </PageWrapper>
  );
}

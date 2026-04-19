import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pricingToolHealthRouter from "./pricing-tool-health";
import dashboardRouter from "./dashboard";
import tourismRouter from "./tourism";
import rentalRouter from "./rental";
import economicRouter from "./economic";
import safetyRouter from "./safety";
import weatherRouter from "./weather";
import sourcesRouter from "./sources";
import compsRouter from "./comps";
import rentalHelpersRouter from "./rental-helpers";
import ingestRouter from "./ingest";
import contactRouter from "./contact";
import airportRouter from "./airport";
import cruiseScheduleRouter from "./cruise-schedule";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pricingToolHealthRouter);
router.use(dashboardRouter);
router.use(tourismRouter);
router.use(rentalRouter);
router.use(economicRouter);
router.use(safetyRouter);
router.use(weatherRouter);
router.use(sourcesRouter);
router.use(rentalHelpersRouter); // must be before compsRouter (comps/prepare vs comps)
router.use(compsRouter);
router.use(ingestRouter);
router.use(airportRouter);
router.use(cruiseScheduleRouter);
router.use("/contact", contactRouter);

export default router;

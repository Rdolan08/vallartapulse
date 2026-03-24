import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import tourismRouter from "./tourism";
import rentalRouter from "./rental";
import economicRouter from "./economic";
import safetyRouter from "./safety";
import weatherRouter from "./weather";
import sourcesRouter from "./sources";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(tourismRouter);
router.use(rentalRouter);
router.use(economicRouter);
router.use(safetyRouter);
router.use(weatherRouter);
router.use(sourcesRouter);

export default router;

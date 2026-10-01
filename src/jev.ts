/**
 * The Jev judgement model every extension asks. One place, so a new version
 * is one change (or PRJCT_JEV_MODEL), not six pins drifting apart.
 */
export const JEV_MODEL = process.env.PRJCT_JEV_MODEL?.trim() || "jev-1.13.0";

// @ts-check
// Stage 6: deliver-plan, deliver-step, deliver-merged, pr-state, task-source-done, platform, platform-warn, batch-ci (A215).
import { bytes } from '../config.mjs';
import { batchCi, deliverMerged, deliverPlan, deliverStep, prState, preLockRead, taskSourceDone } from '../deliver.mjs';
import { requireLead } from '../approve.mjs';
import { need } from '../lifeutil.mjs';
import { detectPlatform, detectText, warnText } from '../platform.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const DELIVERCMD_HANDLERS = {
  'deliver-plan': (ctx, args) => { ctx.fpMode = 'refresh'; requireLead(ctx); const id = need(args, 0); return deliverPlan(ctx, id, args.slice(1)); },
  'deliver-step': (ctx, args) => { ctx.fpMode = 'refresh'; requireLead(ctx); const id = need(args, 0); const step = need(args, 1); return deliverStep(ctx, id, step, bytes(args[2] ?? '')); },
  'deliver-merged': (ctx, args) => { ctx.fpMode = 'refresh'; requireLead(ctx); const id = need(args, 0); return deliverMerged(ctx, id, bytes(args[1] ?? '')); },
  'pr-state': (ctx, args) => prState(ctx, need(args, 0)),
  'task-source-done': (ctx, args) => { ctx.fpMode = 'refresh'; requireLead(ctx); return taskSourceDone(ctx, need(args, 0)); },
  platform: (ctx) => { ctx.out(detectText(detectPlatform(ctx))); return 0; },
  'platform-warn': (ctx) => { ctx.out(warnText(detectPlatform(ctx))); return 0; },
  'batch-ci': (ctx, args) => { requireLead(ctx); return batchCi(ctx, need(args, 0)); },
};

/** What a command reads from the platform before its locks are taken (a slow tool never holds them). @type {Record<string, (ctx: Context, args: string[]) => void>} */
export const PRELOCK = { 'deliver-step': (ctx, args) => preLockRead(ctx, args.map((a) => bytes(a))) };

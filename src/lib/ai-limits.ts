import type { Db, DbTx } from "@/lib/db";
import { limitsEnv } from "@/lib/env";
import { UserError } from "@/lib/errors";
import { startOfDay, startOfMonth } from "@/lib/time";
import { listMembers } from "@/lib/users";

/**
 * How much the AI may cost, in USD. A company and each of its members have a daily and a monthly
 * cap; the environment gives the defaults and Usage lets admins override them. Spend is the sum of
 * recorded AiUsage costs, so a cap can be overshot by at most one call.
 */

export type Limits = { dailyUsd: number; monthlyUsd: number };
export type Spend = { dayUsd: number; monthUsd: number };
type Overrides = { aiDailyUsd: number | null; aiMonthlyUsd: number | null };

const money = (usd: number) => `$${usd.toFixed(2)}`;

function resolve(overrides: Overrides | null, defaults: Limits): Limits {
  return { dailyUsd: overrides?.aiDailyUsd ?? defaults.dailyUsd, monthlyUsd: overrides?.aiMonthlyUsd ?? defaults.monthlyUsd };
}

export function companyDefaults(): Limits {
  const env = limitsEnv();
  return { dailyUsd: env.AI_DAILY_USD, monthlyUsd: env.AI_MONTHLY_USD };
}

export function memberDefaults(): Limits {
  const env = limitsEnv();
  return { dailyUsd: env.AI_USER_DAILY_USD, monthlyUsd: env.AI_USER_MONTHLY_USD };
}

async function spent(prisma: DbTx, where: { orgId: string; userId?: string }, since: Date): Promise<number> {
  const sum = await prisma.aiUsage.aggregate({ _sum: { costUsd: true }, where: { ...where, createdAt: { gte: since } } });
  return sum._sum.costUsd ?? 0;
}

export type LimitReason = "user_day" | "user_month" | "company_day" | "company_month" | "company_calls";

export type BudgetCheck = { ok: true } | { ok: false; reason: LimitReason; message: string };

/** Whether one more call is allowed now. Owners without a membership get the member defaults. */
export async function checkBudget(
  prisma: DbTx,
  scope: { orgId: string; userId?: string | null; timezone: string },
  now = new Date(),
): Promise<BudgetCheck> {
  const day = startOfDay(now, scope.timezone);
  const month = startOfMonth(now, scope.timezone);
  const org = await prisma.organization.findUnique({ where: { id: scope.orgId }, select: { aiDailyUsd: true, aiMonthlyUsd: true } });
  const company = resolve(org, companyDefaults());

  if (scope.userId) {
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: scope.userId, orgId: scope.orgId } },
      select: { aiDailyUsd: true, aiMonthlyUsd: true },
    });
    const mine = resolve(membership, memberDefaults());
    const where = { orgId: scope.orgId, userId: scope.userId };
    if ((await spent(prisma, where, day)) >= mine.dailyUsd) {
      return { ok: false, reason: "user_day", message: `You have reached your daily AI limit (${money(mine.dailyUsd)}).` };
    }
    if ((await spent(prisma, where, month)) >= mine.monthlyUsd) {
      return { ok: false, reason: "user_month", message: `You have reached your monthly AI limit (${money(mine.monthlyUsd)}).` };
    }
  }
  const where = { orgId: scope.orgId };
  if ((await spent(prisma, where, day)) >= company.dailyUsd) {
    return { ok: false, reason: "company_day", message: `The company has reached its daily AI limit (${money(company.dailyUsd)}).` };
  }
  if ((await spent(prisma, where, month)) >= company.monthlyUsd) {
    return { ok: false, reason: "company_month", message: `The company has reached its monthly AI limit (${money(company.monthlyUsd)}).` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The Usage dashboard
// ---------------------------------------------------------------------------------------------

type Counts = { reads: number; searches: number; usd: number };

export type UsageRow = {
  userId: string;
  email: string;
  name: string | null;
  role: "admin" | "editor" | "viewer";
  isOwner: boolean;
  isActive: boolean;
  /** Null for an owner with no membership here: their caps are the defaults and cannot be changed. */
  overrides: Overrides | null;
  limits: Limits;
  today: Counts;
  month: Counts;
};

export type UsageReport = {
  company: { overrides: Overrides; limits: Limits; today: Counts; month: Counts };
  defaults: { company: Limits; member: Limits };
  people: UsageRow[];
};

async function countsByUser(prisma: Db, orgId: string, since: Date): Promise<Map<string | null, Counts>> {
  const groups = await prisma.aiUsage.groupBy({
    by: ["userId", "purpose"],
    where: { orgId, createdAt: { gte: since } },
    _sum: { costUsd: true },
    _count: { _all: true },
  });
  const out = new Map<string | null, Counts>();
  for (const g of groups) {
    const row = out.get(g.userId) ?? { reads: 0, searches: 0, usd: 0 };
    if (g.purpose === "file_analysis") row.reads += g._count._all;
    else row.searches += g._count._all;
    row.usd += g._sum.costUsd ?? 0;
    out.set(g.userId, row);
  }
  return out;
}

const total = (rows: Iterable<Counts>): Counts => {
  const sum = { reads: 0, searches: 0, usd: 0 };
  for (const r of rows) {
    sum.reads += r.reads;
    sum.searches += r.searches;
    sum.usd += r.usd;
  }
  return sum;
};

export async function usageReport(prisma: Db, org: { id: string; timezone: string }, now = new Date()): Promise<UsageReport> {
  const [orgRow, members, memberships, today, month] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { aiDailyUsd: true, aiMonthlyUsd: true } }),
    listMembers(prisma, org.id),
    prisma.membership.findMany({ where: { orgId: org.id }, select: { userId: true, aiDailyUsd: true, aiMonthlyUsd: true } }),
    countsByUser(prisma, org.id, startOfDay(now, org.timezone)),
    countsByUser(prisma, org.id, startOfMonth(now, org.timezone)),
  ]);
  const overridesByUser = new Map(memberships.map((m) => [m.userId, { aiDailyUsd: m.aiDailyUsd, aiMonthlyUsd: m.aiMonthlyUsd }]));
  const none = { reads: 0, searches: 0, usd: 0 };
  const defaults = { company: companyDefaults(), member: memberDefaults() };
  return {
    company: { overrides: orgRow, limits: resolve(orgRow, defaults.company), today: total(today.values()), month: total(month.values()) },
    defaults,
    people: members.map((m) => {
      const overrides = overridesByUser.get(m.userId) ?? null;
      return {
        userId: m.userId,
        email: m.email,
        name: m.name,
        role: m.role,
        isOwner: m.isOwner,
        isActive: m.isActive,
        overrides,
        limits: resolve(overrides, defaults.member),
        today: today.get(m.userId) ?? none,
        month: month.get(m.userId) ?? none,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Changing caps
// ---------------------------------------------------------------------------------------------

type Actor = { orgId: string; email: string };
type NewLimits = { dailyUsd: number | null; monthlyUsd: number | null };

function checkLimits(input: NewLimits): void {
  for (const value of [input.dailyUsd, input.monthlyUsd]) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100_000)) throw new UserError("Enter a dollar amount from 0 to 100,000, or leave it empty for the default.");
  }
}

/** A member's caps; null restores the default. Audited. */
export async function setMemberLimits(prisma: Db, actor: Actor, input: { userId: string } & NewLimits): Promise<void> {
  checkLimits(input);
  await prisma.$transaction(async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { userId_orgId: { userId: input.userId, orgId: actor.orgId } },
      select: { id: true, aiDailyUsd: true, aiMonthlyUsd: true, user: { select: { email: true } } },
    });
    if (!membership) throw new UserError("That person is not a member of this company.");
    await tx.membership.update({ where: { id: membership.id }, data: { aiDailyUsd: input.dailyUsd, aiMonthlyUsd: input.monthlyUsd } });
    await tx.auditLog.create({
      data: {
        orgId: actor.orgId,
        userEmail: actor.email,
        action: "ai.limits",
        targetType: "user",
        targetId: input.userId,
        before: { email: membership.user.email, dailyUsd: membership.aiDailyUsd, monthlyUsd: membership.aiMonthlyUsd },
        after: { email: membership.user.email, dailyUsd: input.dailyUsd, monthlyUsd: input.monthlyUsd },
      },
    });
  });
}

/** The company's caps; null restores the default. Audited. */
export async function setCompanyLimits(prisma: Db, actor: Actor, input: NewLimits): Promise<void> {
  checkLimits(input);
  await prisma.$transaction(async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { aiDailyUsd: true, aiMonthlyUsd: true } });
    await tx.organization.update({ where: { id: actor.orgId }, data: { aiDailyUsd: input.dailyUsd, aiMonthlyUsd: input.monthlyUsd } });
    await tx.auditLog.create({
      data: {
        orgId: actor.orgId,
        userEmail: actor.email,
        action: "ai.limits",
        targetType: "organization",
        targetId: actor.orgId,
        before: { dailyUsd: before.aiDailyUsd, monthlyUsd: before.aiMonthlyUsd },
        after: { dailyUsd: input.dailyUsd, monthlyUsd: input.monthlyUsd },
      },
    });
  });
}

import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Db, Row } from './db';
import { CareService, activityWindow } from './care';
import { CurrentUser } from './http';
import { timezoneForPet } from './identity';

const querySchema = z.object({ date: z.iso.date().optional(), timezone: z.string().optional() });
const currentQuerySchema = z.object({ timezone: z.string().optional() }).strict();
const ruleVersion = 'activity-observation-v1';
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const coverage = (summary: Row, metric: string) => {
  const seconds = (Date.parse(summary.period_end) - Date.parse(summary.period_start)) / 1000;
  return seconds > 0 ? summary.metric_coverage_seconds[metric] / seconds : 0;
};

export class ObservationsService {
  constructor(@Inject(Db) readonly db: Db, @Inject(CareService) readonly care: CareService) {}

  async current(user: string, petId: string, raw: unknown = {}): Promise<Row> {
    const query = currentQuerySchema.parse(raw);
    return this.db.transaction(async () => {
      await this.db.pet(user, petId);
      const now = this.db.clock(), asOf = now.toISOString(), timezone = await timezoneForPet(this.db, petId, query.timezone);
      const today = activityWindow(undefined, timezone, now), elapsed = now.getTime() - Date.parse(today.start);
      const target = await this.care.interval(user, petId, { ...today, end: asOf });
      const baseline: Row[] = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
        const day = activityWindow(shiftDate(today.date, index - 7), timezone, now);
        const eligible = Date.parse(day.end) - Date.parse(day.start) >= elapsed;
        const end = new Date(Math.min(Date.parse(day.end), Date.parse(day.start) + elapsed)).toISOString();
        return { ...(await this.care.interval(user, petId, { ...day, end })), eligible,
          exclusion_reason: eligible ? null : 'shorter_calendar_day' };
      }));
      const id = this.db.id(), comparisons: Row[] = [], evidence: Row[] = [], observations: Row[] = [];
      for (const [metric, coverageMetric, label] of [['steps', 'steps', '步数'], ['active_minutes', 'active_seconds', '活动分钟数']]) {
        const qualified = baseline.filter(day => day.eligible && day[metric] !== null && coverage(day, coverageMetric) >= 0.5);
        const fraction = coverage(target, coverageMetric);
        const reason = elapsed === 0 ? 'period_not_started' : target[metric] === null ? 'missing_metric'
          : fraction < 0.5 ? 'insufficient_coverage' : qualified.length < 3 ? 'insufficient_baseline' : null;
        const comparison: Row = { metric, observed: target[metric], coverage_fraction: fraction,
          baseline_days: qualified.length, status: reason ? 'unavailable' : 'ready', reason };
        comparisons.push(comparison);
        if (reason) continue;
        const value = median(qualified.map(day => day[metric]));
        const delta = value > 0 ? Math.round((target[metric] - value) / value * 10_000) / 100 : null;
        const evidenceId = `${id}:${metric}`;
        Object.assign(comparison, { baseline_median: value, delta_percent: delta, reason: value === 0 ? 'baseline_zero' : null, evidence_id: evidenceId });
        evidence.push({ id: evidenceId, metric, source: 'activity_samples', observed: target[metric], baseline_median: value, delta_percent: delta,
          coverage_fraction: fraction, estimated: target.estimated || qualified.some(day => day.estimated),
          aggregation_version: target.aggregation_version, target: this.summaryEvidence(target, coverageMetric),
          baseline: qualified.map(day => this.summaryEvidence(day, coverageMetric)) });
        if (delta !== null && Math.abs(delta) >= 30) observations.push({ metric, evidence_ids: [evidenceId], comparison_basis: 'equal_elapsed_since_local_midnight',
          text: `截至查询时刻已上报${label}为${target[metric]}，该时段指标覆盖率为${Math.round(fraction * 100)}%；前7个自然日中${qualified.length}个合格同等时长窗口的上报总量中位数为${value}，变化${delta}%。` });
      }
      return { id, pet_id: petId, local_date: today.date, timezone, rule_version: 'activity-current-v1', as_of: asOf, generated_at: asOf,
        elapsed_seconds: elapsed / 1000, comparison_basis: 'equal_elapsed_since_local_midnight',
        status: elapsed === 0 ? 'period_not_started' : comparisons.some(item => item.status === 'ready') ? 'ready' : 'insufficient_data',
        target, baseline_window: { from_date: shiftDate(today.date, -7), to_date: shiftDate(today.date, -1) }, baseline,
        minimum_coverage_fraction: 0.5, minimum_baseline_days: 3, comparisons, evidence, observations,
        missing_context: ['佩戴情况', '环境与日常安排'], model_output: null };
    });
  }

  async get(user: string, petId: string, raw: unknown): Promise<Row> {
    await this.db.pet(user, petId);
    const query = querySchema.parse(raw), timezone = await timezoneForPet(this.db, petId, query.timezone);
    const today = activityWindow(undefined, timezone, this.db.clock()).date;
    const date = query.date ?? shiftDate(today, -1);
    const target = await this.care.daily(user, petId, { date, timezone });
    const completed = Date.parse(target.period_end) <= this.db.clock().getTime();
    const baseline = completed ? (await Promise.all(Array.from({ length: 7 }, async (_, index) => await this.care.daily(user, petId, { date: shiftDate(date, index - 7), timezone })))) : [];
    const signature = JSON.stringify({ completed, summaries: [target, ...baseline].map(day => [day.local_date, day.aggregation_version, day.source_revision]) });
    const saved = await this.db.get(`SELECT result_json FROM activity_observations WHERE pet_id=? AND local_date=? AND timezone=? AND rule_version=? AND source_signature=?`, petId, date, timezone, ruleVersion, signature);
    if (saved) return JSON.parse(saved.result_json);

    const id = this.db.id(), comparisons: Row[] = [], evidence: Row[] = [], observations: Row[] = [];
    for (const [metric, coverageMetric, label] of [['steps', 'steps', '步数'], ['active_minutes', 'active_seconds', '活动分钟数']]) {
      const qualified = baseline.filter(day => day[metric] !== null && coverage(day, coverageMetric) >= 0.5);
      const fraction = coverage(target, coverageMetric);
      const reason = !completed ? 'period_not_completed' : target[metric] === null ? 'missing_metric'
        : fraction < 0.5 ? 'insufficient_coverage' : qualified.length < 3 ? 'insufficient_baseline' : null;
      const comparison: Row = { metric, observed: target[metric], coverage_fraction: fraction,
        baseline_days: qualified.length, status: reason ? 'unavailable' : 'ready', reason };
      comparisons.push(comparison);
      if (reason) continue;
      const value = median(qualified.map(day => day[metric]));
      const delta = value > 0 ? Math.round((target[metric] - value) / value * 10_000) / 100 : null;
      const evidenceId = `${id}:${metric}`;
      Object.assign(comparison, { baseline_median: value, delta_percent: delta, reason: value === 0 ? 'baseline_zero' : null, evidence_id: evidenceId });
      evidence.push({ id: evidenceId, metric, source: 'activity_samples', observed: target[metric], baseline_median: value, delta_percent: delta,
        coverage_fraction: fraction, estimated: target.estimated || qualified.some(day => day.estimated),
        aggregation_version: target.aggregation_version,
        target: this.summaryEvidence(target, coverageMetric), baseline: qualified.map(day => this.summaryEvidence(day, coverageMetric)) });
      if (delta !== null && Math.abs(delta) >= 30) observations.push({ metric, evidence_ids: [evidenceId], comparison_basis: 'reported_totals_with_coverage',
        text: `已上报${label}为${target[metric]}，该指标当日覆盖率为${Math.round(fraction * 100)}%；前7个自然日中${qualified.length}个合格日的上报总量中位数为${value}，变化${delta}%。` });
    }
    const result = { id, pet_id: petId, local_date: date, timezone, rule_version: ruleVersion, generated_at: this.db.now(),
      status: !completed ? 'day_in_progress' : comparisons.some(item => item.status === 'ready') ? 'ready' : 'insufficient_data',
      baseline_window: { from_date: shiftDate(date, -7), to_date: shiftDate(date, -1) },
      minimum_coverage_fraction: 0.5, minimum_baseline_days: 3, comparisons, evidence, observations,
      missing_context: ['佩戴情况', '环境与日常安排'], model_output: null };
    await this.db.run(`INSERT INTO activity_observations VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pet_id,local_date,timezone,rule_version,source_signature) DO NOTHING`,
      id, petId, date, timezone, ruleVersion, signature, result.generated_at, JSON.stringify(result));
    return JSON.parse((await this.db.get('SELECT result_json FROM activity_observations WHERE pet_id=? AND local_date=? AND timezone=? AND rule_version=? AND source_signature=?', petId, date, timezone, ruleVersion, signature))!.result_json);
  }

  private summaryEvidence(summary: Row, metric: string) {
    return { local_date: summary.local_date, period_start: summary.period_start, period_end: summary.period_end,
      source_revision: summary.source_revision, generated_at: summary.generated_at,
      metric_coverage_seconds: summary.metric_coverage_seconds[metric], coverage_fraction: coverage(summary, metric) };
  }
}

@ApiTags('activity-observations') @ApiBearerAuth()
@Controller('pets/:id/observations')
export class ObservationsController {
  constructor(@Inject(ObservationsService) readonly observations: ObservationsService) {}
  @Get('current') @ApiQuery({ name: 'timezone', required: false, description: '本次比较使用的 IANA 时区；默认继承宠物和家庭设置' })
  current(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.observations.current(user, id, query); }
  @Get() get(@CurrentUser() user: string, @Param('id') id: string, @Query() query: unknown) { return this.observations.get(user, id, query); }
}

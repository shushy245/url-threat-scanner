import { isErrored } from '../domain/scan/selectors';
import { CheckId, Verdict } from '../domain/scan/model';
import type { ScanCheckModel } from '../domain/scan/model';

export type ScanScore = { readonly threatScore: number; readonly verdict: Verdict };

/**
 * How much each check's finding counts toward the composite score. This table is the only home of
 * the weighting policy: a check reports the severity of its OWN finding and knows nothing about its
 * contribution to the total, so adding a check is a new row here, never an edit to a branch chain.
 *
 * The ordering is the phishing-detection one: a domain registered days ago is the single strongest
 * signal, certificate problems next, and a long redirect chain is suggestive but common enough in
 * ad-tech to weigh least.
 *
 * Keyed by the CheckId enum rather than a partial map, so a new check id is a compile error here
 * rather than a silently unweighted check at runtime.
 */
export const checkWeightMap: Record<CheckId, number> = {
    [CheckId.DomainAge]: 4,
    [CheckId.SslCertificate]: 3,
    [CheckId.RedirectChain]: 2,
};

/**
 * Verdict bands, inclusive lower bounds. One named home so the boundaries can be asserted exactly
 * by the tests rather than re-typed as magic numbers in two places.
 */
export const verdictThresholds: { readonly suspicious: number; readonly malicious: number } = {
    suspicious: 30,
    malicious: 70,
};

const MIN_SCORE = 0;
const MAX_SCORE = 100;

const hasSignal = (check: ScanCheckModel): boolean => !isErrored(check);

const weightOf = (check: ScanCheckModel): number => checkWeightMap[check.checkId];

const clampToScale = (score: number): number => Math.min(MAX_SCORE, Math.max(MIN_SCORE, score));

const isMaliciousScore = (threatScore: number): boolean => threatScore >= verdictThresholds.malicious;

const isSuspiciousScore = (threatScore: number): boolean => threatScore >= verdictThresholds.suspicious;

const toVerdict = (threatScore: number): Verdict => {
    if (isMaliciousScore(threatScore)) return Verdict.Malicious;
    if (isSuspiciousScore(threatScore)) return Verdict.Suspicious;

    return Verdict.Clean;
};

const totalWeightOf = (checks: readonly ScanCheckModel[]): number =>
    checks.reduce((total, check) => total + weightOf(check), 0);

const weightedTotalOf = (checks: readonly ScanCheckModel[]): number =>
    checks.reduce((total, check) => total + weightOf(check) * clampToScale(check.score), 0);

/**
 * The weighted mean severity across the checks that actually produced a signal.
 *
 * An errored check is an absence of evidence, not evidence of absence, so it leaves both sides of
 * the fraction — counting it as a pass would let a WHOIS outage dilute a real failure into looking
 * safer than it is.
 */
export const scoreScan = (checks: readonly ScanCheckModel[]): ScanScore => {
    const scorable = checks.filter(hasSignal);
    const totalWeight = totalWeightOf(scorable);

    // Every check errored, or there were none: the denominator is empty. Without this branch the
    // division is 0/0 — and that NaN goes straight into an integer column. Unknown is deliberately
    // not Clean: a security product must never report "safe" when it means "could not tell".
    if (totalWeight === 0) return { threatScore: 0, verdict: Verdict.Unknown };

    const threatScore = clampToScale(Math.round(weightedTotalOf(scorable) / totalWeight));

    return { threatScore, verdict: toVerdict(threatScore) };
};

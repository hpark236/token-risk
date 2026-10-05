// Statistics for the validation study: ROC AUC, Brier score, log loss and L2 logistic regression.

export const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

/** ROC AUC via the Mann-Whitney U statistic, with ties counted as half. */
export function auc(scores, y) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 1, sumPos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i; while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++;
    const r = (rank + rank + (j - i) - 1) / 2;
    for (let k = i; k < j; k++) if (y[idx[k]]) sumPos += r;
    rank += j - i; i = j;
  }
  const P = y.filter(Boolean).length, N = y.length - P;
  return P && N ? (sumPos - P * (P + 1) / 2) / (P * N) : null;
}
export const brier = (p, y) => mean(p.map((q, i) => (q - y[i]) ** 2));
export const logloss = (p, y) => -mean(p.map((q, i) => { q = Math.min(1 - 1e-9, Math.max(1e-9, q)); return y[i] ? Math.log(q) : Math.log(1 - q); }));

/** L2-regularised logistic regression on standardised features, fitted by Newton's method. */
export function fitLogistic(X, y, lambda = 1) {
  const n = X.length, d = X[0].length;
  const mu = Array.from({ length: d }, (_, j) => mean(X.map(r => r[j])));
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(mean(X.map(r => (r[j] - mu[j]) ** 2))) || 1);
  const Z = X.map(r => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
  let w = new Array(d + 1).fill(0);
  for (let it = 0; it < 50; it++) {
    const g = new Array(d + 1).fill(0), H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i].reduce((s, v, j) => s + v * w[j], 0), p = 1 / (1 + Math.exp(-z)), r = p - y[i], s = p * (1 - p);
      for (let a = 0; a <= d; a++) { g[a] += r * Z[i][a]; for (let b = 0; b <= d; b++) H[a][b] += s * Z[i][a] * Z[i][b]; }
    }
    for (let a = 1; a <= d; a++) { g[a] += lambda * w[a]; H[a][a] += lambda; } // no penalty on the intercept
    const step = solve(H, g);
    w = w.map((v, j) => v - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { b: w[0], w: w.slice(1), mean: mu, sd };
}
function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// The reference trade history — "how I trade" — extracted from the uploaded
// journal (15 trades). This is the target the learner tunes toward: it's what
// the strategy is being taught to reproduce. Update it as more of your real
// trades come in and re-run `npm run learn` to teach the engine the new profile.

export interface RawTrade {
  date: string;
  side: 'long' | 'short';
  entry: number;
  stop: number;
  exit: number;
}

export const USER_TRADES: RawTrade[] = [
  { date: '2026-01-01', side: 'long', entry: 2974.91, stop: 2971.33, exit: 3014.0 },
  { date: '2026-01-02', side: 'long', entry: 3024.55, stop: 3015.16, exit: 3155.0 },
  { date: '2026-01-04', side: 'long', entry: 3122.34, stop: 3111.25, exit: 3208.92 },
  { date: '2026-01-05', side: 'short', entry: 3207.67, stop: 3222.94, exit: 3135.27 },
  { date: '2026-01-05', side: 'long', entry: 3146.61, stop: 3129.17, exit: 3258.7 },
  { date: '2026-01-06', side: 'long', entry: 3212.57, stop: 3200.0, exit: 3263.31 },
  { date: '2026-01-07', side: 'short', entry: 3294.16, stop: 3311.0, exit: 3209.46 },
  { date: '2026-01-07', side: 'short', entry: 3274.77, stop: 3311.0, exit: 3180.38 },
  { date: '2026-01-08', side: 'short', entry: 3172.31, stop: 3181.76, exit: 3106.13 },
  { date: '2026-01-09', side: 'short', entry: 3122.57, stop: 3146.36, exit: 3061.76 },
  { date: '2026-01-10', side: 'short', entry: 3094.47, stop: 3098.72, exit: 3073.43 },
  { date: '2026-01-11', side: 'long', entry: 3094.47, stop: 3079.84, exit: 3118.31 },
  { date: '2026-01-12', side: 'short', entry: 3124.48, stop: 3129.48, exit: 3097.46 },
  { date: '2026-01-12', side: 'long', entry: 3101.19, stop: 3090.38, exit: 3143.24 },
  { date: '2026-01-12', side: 'short', entry: 3157.92, stop: 3167.39, exit: 3074.28 },
];

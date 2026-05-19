/**
 * @packageDocumentation
 * @module policy/sizer
 * @description Maps a `PortfolioRating` to a USD notional. The default sizer
 * is intentionally trivial — production deployments override it with a
 * risk-budget-aware sizer. Mirrored Buy/Sell are the same magnitude;
 * Overweight/Underweight halve it; Hold is zero.
 */

import type { PortfolioRating } from '../schemas/index.js';
import type { ProposalAction } from './types.js';

/** Maps a 5-tier rating to a 3-way action. */
export function ratingToAction(rating: PortfolioRating): ProposalAction {
  switch (rating) {
    case 'Buy':
    case 'Overweight':
      return 'Buy';
    case 'Sell':
    case 'Underweight':
      return 'Sell';
    case 'Hold':
      return 'Hold';
  }
}

/**
 * Returns the proposed USD notional for a rating given the configured
 * `max_position_usd`. Conviction maps to fraction-of-max:
 *
 *   Buy / Sell          → 100% of max_position_usd
 *   Overweight / Under  →  50%
 *   Hold                →   0
 */
export function defaultSizer(
  rating: PortfolioRating,
  maxPositionUsd: number,
): number {
  if (maxPositionUsd <= 0) return 0;
  switch (rating) {
    case 'Buy':
    case 'Sell':
      return maxPositionUsd;
    case 'Overweight':
    case 'Underweight':
      return maxPositionUsd * 0.5;
    case 'Hold':
      return 0;
  }
}

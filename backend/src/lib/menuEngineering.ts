/**
 * Menu engineering: which dishes to keep, reprice, promote, or drop.
 *
 * The classic Kasavana–Smith matrix, and the one capability every restaurant
 * back-office guide treats as the reason to own one at all. This system already
 * had the inputs — units sold, revenue and cost per item, per window — and did
 * nothing with them: the reports page could say which dish earned the most
 * money, which is a different and much weaker question than which dish is worth
 * keeping on the menu.
 *
 * ----------------------------------------------------------------------------
 * THE TWO AXES, AND WHY THEY ARE THESE TWO.
 *
 * POPULARITY — an item's share of units sold, against an equal share.
 *   With N items on the menu an equal share is 1/N. The convention is to call
 *   an item popular at 70% of that rather than at 100%, because demand is never
 *   uniform and a strict average would mark nearly half of any real menu
 *   unpopular by definition.
 *
 * PROFITABILITY — contribution margin PER UNIT, against the menu average.
 *   Cash, not percentage. A garnish with an 80% margin contributes a few pounds
 *   an evening; a mixed grill at 45% pays the rent. Ranking a menu by margin
 *   percentage is the classic way to end up promoting the cheapest thing on it.
 *
 * ----------------------------------------------------------------------------
 * WHAT AN UNKNOWN COST MUST NOT DO.
 *
 * An item whose cost is not fully known has an unknown margin, and folding it
 * in at cost zero makes the dish nobody has costed look like the most
 * profitable thing on the menu — which is precisely the item somebody would
 * then promote. Those items are classified UNKNOWN, excluded from the averages
 * that decide everyone else's quadrant, and reported so they can be costed.
 *
 * This is the same rule the profitability report already applies to margin
 * coverage; it must not be softened here just because a quadrant looks tidier
 * with every item in it.
 */

export type MenuQuadrant =
  /** Sells well, earns well. Protect it: position, availability, consistency. */
  | 'star'
  /** Sells well, earns little. The price or the recipe is wrong, not the dish. */
  | 'plowhorse'
  /** Earns well, sells rarely. A menu-position and description problem. */
  | 'puzzle'
  /** Neither. A candidate to remove, and the prep space it frees is the point. */
  | 'dog'
  /** Cost is not fully known, so its margin is not either. */
  | 'unknown';

export interface MenuItemInput {
  id: string;
  name: string;
  units_sold: number;
  revenue: number;
  /** Cost of goods for the units sold. */
  cost: number;
  /** False when any sold unit lacked a complete cost. */
  cost_is_complete: boolean;
}

export interface MenuItemVerdict extends MenuItemInput {
  quadrant: MenuQuadrant;
  /** Cash contribution per unit sold — the axis, exposed so a table can sort by it. */
  unit_margin: number | null;
  /** Share of all units sold across the window, 0..1. */
  popularity: number;
}

export interface MenuEngineeringResult {
  items: MenuItemVerdict[];
  /** The two thresholds, so a screen can say WHY an item landed where it did. */
  thresholds: {
    popularity: number;
    unit_margin: number;
  };
  counts: Record<MenuQuadrant, number>;
}

/** The Kasavana–Smith convention: 70% of an equal share counts as popular. */
const POPULARITY_FACTOR = 0.7;

export function classifyMenu(items: MenuItemInput[]): MenuEngineeringResult {
  const counts: Record<MenuQuadrant, number> = {
    star: 0,
    plowhorse: 0,
    puzzle: 0,
    dog: 0,
    unknown: 0,
  };

  // Only items with a known cost may influence the thresholds. An item costed
  // at zero would drag the average margin up and quietly demote real dishes
  // into "plowhorse".
  const costed = items.filter((i) => i.cost_is_complete && i.units_sold > 0);
  const totalUnits = items.reduce((sum, i) => sum + i.units_sold, 0);
  const costedUnits = costed.reduce((sum, i) => sum + i.units_sold, 0);
  const costedMargin = costed.reduce((sum, i) => sum + (i.revenue - i.cost), 0);

  // Weighted by units, not a mean of per-item margins: one rarely-sold luxury
  // dish should not set the bar for the whole menu.
  const avgUnitMargin = costedUnits > 0 ? costedMargin / costedUnits : 0;

  // An equal share of the menu, discounted by the convention above. With no
  // items at all the threshold is 0 and nothing is popular, which is correct
  // rather than a division by zero.
  const popularityThreshold = items.length > 0 ? (1 / items.length) * POPULARITY_FACTOR : 0;

  const verdicts = items.map((item): MenuItemVerdict => {
    const popularity = totalUnits > 0 ? item.units_sold / totalUnits : 0;
    const unitMargin =
      item.cost_is_complete && item.units_sold > 0
        ? (item.revenue - item.cost) / item.units_sold
        : null;

    let quadrant: MenuQuadrant;
    if (unitMargin === null) {
      quadrant = 'unknown';
    } else {
      const popular = popularity >= popularityThreshold;
      const profitable = unitMargin >= avgUnitMargin;
      if (popular && profitable) quadrant = 'star';
      else if (popular) quadrant = 'plowhorse';
      else if (profitable) quadrant = 'puzzle';
      else quadrant = 'dog';
    }

    counts[quadrant] += 1;
    return { ...item, quadrant, unit_margin: unitMargin, popularity };
  });

  return {
    items: verdicts,
    thresholds: { popularity: popularityThreshold, unit_margin: avgUnitMargin },
    counts,
  };
}

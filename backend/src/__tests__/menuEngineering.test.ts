import { describe, expect, it } from '@jest/globals';
import { classifyMenu } from '../lib/menuEngineering';
import type { MenuItemInput } from '../lib/menuEngineering';

/**
 * Which dishes to keep, reprice, promote, or drop.
 *
 * The judgement this file encodes is worth more than the arithmetic, and two
 * decisions in it are the ones somebody will be tempted to "simplify" later:
 *
 *   1. profitability is CASH PER UNIT, not margin percentage. Rank a menu by
 *      percentage and the cheapest garnish wins;
 *   2. an item whose cost is unknown is not classified at all, and does not
 *      influence anybody else's threshold. Folded in at cost zero it becomes
 *      the most profitable thing on the menu — the one item a manager would
 *      then go and promote.
 */

const item = (over: Partial<MenuItemInput> & { id: string }): MenuItemInput => ({
  name: over.id,
  units_sold: 10,
  revenue: 1000,
  cost: 400,
  cost_is_complete: true,
  ...over,
});

describe('the four quadrants', () => {
  // A menu where each item is deliberately in one corner. Four items, so an
  // equal share is 25% and the popularity threshold is 17.5%.
  const menu: MenuItemInput[] = [
    // sells a lot, earns a lot per plate
    item({ id: 'star', units_sold: 100, revenue: 20_000, cost: 6_000 }),
    // sells a lot, earns little per plate
    item({ id: 'plowhorse', units_sold: 100, revenue: 5_000, cost: 4_000 }),
    // sells rarely, earns a lot per plate
    item({ id: 'puzzle', units_sold: 5, revenue: 2_000, cost: 400 }),
    // sells rarely, earns little
    item({ id: 'dog', units_sold: 4, revenue: 200, cost: 160 }),
  ];

  const byId = (id: string) => classifyMenu(menu).items.find((i) => i.id === id)!;

  it('names the dish that sells well and earns well a star', () => {
    expect(byId('star').quadrant).toBe('star');
  });

  it('names the popular low-margin dish a plowhorse, not a failure', () => {
    // It is doing its job: bringing people in. The price or the recipe is what
    // is wrong, and calling it a dog would get a bestseller removed.
    expect(byId('plowhorse').quadrant).toBe('plowhorse');
  });

  it('names the profitable rarely-sold dish a puzzle', () => {
    // A menu-position and description problem, not a kitchen one.
    expect(byId('puzzle').quadrant).toBe('puzzle');
  });

  it('names the dish that does neither a dog', () => {
    expect(byId('dog').quadrant).toBe('dog');
  });
});

describe('cash, not percentage', () => {
  it('ranks by contribution per plate, so a cheap high-percentage item is not a star', () => {
    /**
     * The garnish has an 80% margin and contributes 4 per plate. The grill has
     * a 40% margin and contributes 120. Ranked by PERCENTAGE the garnish wins
     * and a manager is told to push it; ranked by cash the grill does.
     *
     * Both sell identically here, so popularity cannot be what separates them.
     */
    const menu: MenuItemInput[] = [
      item({ id: 'garnish', units_sold: 50, revenue: 250, cost: 50 }),
      item({ id: 'grill', units_sold: 50, revenue: 15_000, cost: 9_000 }),
    ];
    const result = classifyMenu(menu);
    const garnish = result.items.find((i) => i.id === 'garnish')!;
    const grill = result.items.find((i) => i.id === 'grill')!;

    expect(grill.quadrant).toBe('star');
    expect(garnish.quadrant).toBe('plowhorse');
    expect(garnish.unit_margin).toBeCloseTo(4);
    expect(grill.unit_margin).toBeCloseTo(120);
  });
});

describe('an unknown cost', () => {
  const menu: MenuItemInput[] = [
    item({ id: 'known-a', units_sold: 50, revenue: 5_000, cost: 2_000 }),
    item({ id: 'known-b', units_sold: 50, revenue: 4_000, cost: 3_000 }),
    // Sells well; nobody has costed it. cost 0 is not a cost of zero.
    item({ id: 'uncosted', units_sold: 60, revenue: 9_000, cost: 0, cost_is_complete: false }),
  ];

  it('is not a star, however well the dish sells', () => {
    const uncosted = classifyMenu(menu).items.find((i) => i.id === 'uncosted')!;
    expect(uncosted.quadrant).toBe('unknown');
    expect(uncosted.unit_margin).toBeNull();
  });

  it('does not drag the threshold that judges everybody else', () => {
    // With the uncosted item folded in at cost 0 its margin would be 150 a
    // plate, hauling the average up and demoting a genuinely good dish.
    const withUncosted = classifyMenu(menu);
    const withoutIt = classifyMenu(menu.filter((i) => i.id !== 'uncosted'));

    expect(withUncosted.thresholds.unit_margin).toBeCloseTo(withoutIt.thresholds.unit_margin);
    expect(withUncosted.items.find((i) => i.id === 'known-a')!.quadrant).toBe(
      withoutIt.items.find((i) => i.id === 'known-a')!.quadrant,
    );
  });

  it('is still counted and still reported, so it can be fixed', () => {
    // Hiding it would leave a manager believing the menu is fully analysed.
    expect(classifyMenu(menu).counts.unknown).toBe(1);
  });
});

describe('the thresholds are stated, not implied', () => {
  it('uses 70% of an equal share, not a strict average', () => {
    // A strict average marks nearly half of any real menu unpopular by
    // definition, because demand is never uniform.
    const menu = ['a', 'b', 'c', 'd'].map((id) => item({ id }));
    expect(classifyMenu(menu).thresholds.popularity).toBeCloseTo(0.175);
  });

  it('weights the average margin by units, not by item', () => {
    // One rarely-sold luxury plate must not set the bar for the whole menu.
    const menu: MenuItemInput[] = [
      item({ id: 'volume', units_sold: 100, revenue: 10_000, cost: 5_000 }), // 50/plate
      item({ id: 'rare', units_sold: 1, revenue: 1_000, cost: 100 }), // 900/plate
    ];
    /**
     * Unit-weighted: (5,000 + 900) / 101 plates ≈ 58.4 — a number close to what
     * the kitchen actually sends out. A mean of the two ITEM margins would be
     * (50 + 900) / 2 = 475, a threshold no dish on this menu could clear, set
     * almost entirely by a plate sold once.
     *
     * The volume dish is a plowhorse either way here, and that is worth being
     * exact about: unit weighting exists to make the average REPRESENTATIVE,
     * not to flatter whatever sells most. At 50 a plate against a blended 58.4
     * it genuinely is a popular dish earning below the menu's average, which is
     * the finding, not a rounding artefact.
     */
    const result = classifyMenu(menu);
    expect(result.thresholds.unit_margin).toBeCloseTo(58.4, 1);
    expect(result.thresholds.unit_margin).toBeLessThan(475);
    expect(result.items.find((i) => i.id === 'volume')!.quadrant).toBe('plowhorse');
  });
});

describe('degenerate menus', () => {
  it('an empty menu is not a crash', () => {
    const result = classifyMenu([]);
    expect(result.items).toEqual([]);
    expect(result.thresholds.popularity).toBe(0);
  });

  it('an item that sold nothing is not a star by default', () => {
    // units_sold 0 gives no margin per unit to speak of; it is unknown, not
    // excellent.
    const result = classifyMenu([item({ id: 'never-sold', units_sold: 0, revenue: 0, cost: 0 })]);
    expect(result.items[0].quadrant).toBe('unknown');
  });
});

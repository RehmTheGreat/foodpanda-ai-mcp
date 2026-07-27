import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Prompts are included only where they encode real workflow knowledge that a
 * model would otherwise have to guess: which tool to call first, how to combine
 * results, and which caveats to state. Prompts that merely restate a tool
 * description are noise, so there are three rather than one per tool.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'what_should_i_order',
    {
      title: 'What should I order tonight?',
      description:
        'Guided recommendation flow: resolve the location, check what is open, weigh price against rating, and propose concrete options.',
      argsSchema: {
        location: z.string().describe('Where the user is, e.g. "Clifton, Karachi" or "Bugis, Singapore".'),
        budget: z.string().optional().describe('Optional budget guidance, e.g. "under 1500 PKR for two".'),
        craving: z.string().optional().describe('Optional cuisine or dish the user is in the mood for.'),
      },
    },
    ({ location, budget, craving }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Help me decide what to order from foodpanda near ${location}.` +
              (craving ? ` I'm in the mood for ${craving}.` : '') +
              (budget ? ` Budget: ${budget}.` : '') +
              `\n\nPlease work through this:\n` +
              `1. Use resolve_location on "${location}" and confirm it is in a supported market.\n` +
              `2. Use list_cuisines to see what is actually available nearby.\n` +
              `3. Use search_restaurants with openNow=true` +
              (craving ? ` and query="${craving}"` : '') +
              `, sorted by rating.\n` +
              `4. For your top 2-3 picks, use get_menu to find specific dishes and real prices.\n` +
              `5. Recommend 2-3 concrete options. For each give the restaurant, one or two named dishes with prices, ` +
              `the delivery fee and the minimum order.\n\n` +
              `Be explicit about total cost including delivery. If nothing fits the budget, say so plainly rather than ` +
              `stretching it. Prices come from foodpanda's live listings but the checkout screen is the only authority.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'cheapest_dish_nearby',
    {
      title: 'Find the cheapest version of a dish',
      description:
        'Price-hunting flow for a specific dish, ranking by true landed cost rather than sticker price.',
      argsSchema: {
        dish: z.string().describe('The dish to hunt for, e.g. "chicken biryani".'),
        location: z.string().describe('Where to search from.'),
        radius: z.string().optional().describe('Optional maximum distance, e.g. "3km".'),
      },
    },
    ({ dish, location, radius }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Find me the cheapest ${dish} near ${location}${radius ? ` within ${radius}` : ''}.\n\n` +
              `Use search_menu_items with query="${dish}"` +
              (radius ? `, maxDistanceKm set from "${radius}"` : '') +
              `, includeDeliveryFee=true and restaurantLimit around 15 for decent coverage.\n\n` +
              `Then present a ranked table: dish name, restaurant, item price, delivery fee, total, distance and rating. ` +
              `Call out explicitly whether the cheapest by item price is still cheapest once delivery is added — ` +
              `they are often different restaurants. Mention any minimum-order amount that would force a larger basket.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'compare_delivery_options',
    {
      title: 'Compare delivery options',
      description: 'Structured comparison of several restaurants on cost, speed and rating.',
      argsSchema: {
        restaurants: z.string().describe('Restaurant names or codes to compare, comma separated.'),
        location: z.string().describe('Delivery location, used for distance and time estimates.'),
      },
    },
    ({ restaurants, location }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              `Compare these foodpanda options for delivery to ${location}: ${restaurants}.\n\n` +
              `If you were given names rather than codes, first use search_restaurants to find each one's code. ` +
              `Then call compare_restaurants with all the codes and the delivery coordinates.\n\n` +
              `Present a markdown table with delivery fee, minimum order, estimated time, rating and current deals. ` +
              `Finish with a one-line recommendation that names the trade-off, e.g. cheapest versus fastest, ` +
              `rather than declaring a single winner.`,
          },
        },
      ],
    }),
  );
}

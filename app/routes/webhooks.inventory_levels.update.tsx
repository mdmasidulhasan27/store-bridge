import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, logError, logWarn, withCorrelation } from "../logger.server";
import { syncInventoryToDestinations } from "../inventory-sync.server";

interface InventoryLevelPayload {
  inventory_item_id?: number;
  location_id?: number;
  available?: number;
}

export const action = async ({ request }: ActionFunctionArgs) =>
  withCorrelation(async () => {
    const { topic, shop, payload, admin } = await authenticate.webhook(request);
    const level = payload as InventoryLevelPayload;

    log("webhook", `received ${topic}`, {
      shop,
      inventoryItem: level.inventory_item_id,
      location: level.location_id,
      available: level.available,
    });

    if (
      typeof level.inventory_item_id !== "number" ||
      typeof level.available !== "number"
    ) {
      logWarn("webhook", `skipping ${topic} (unusable payload)`, { shop });
      return new Response(null, { status: 200 });
    }

    if (!admin) {
      logWarn("webhook", "no admin session; cannot resolve source item", {
        shop,
        inventoryItem: level.inventory_item_id,
      });
      return new Response(null, { status: 200 });
    }

    try {
      log("webhook", "reading source inventory item", {
        inventoryItem: level.inventory_item_id,
      });

      const barcode = await resolveSourceBarcode(admin, level.inventory_item_id);
      log("webhook", "resolved source barcode", {
        inventoryItem: level.inventory_item_id,
        barcode: barcode ?? "(none)",
      });

      await syncInventoryToDestinations({ barcode, quantity: level.available });

      log("webhook", `${topic} handled`, {
        shop,
        inventoryItem: level.inventory_item_id,
        available: level.available,
      });

      return new Response(null, { status: 200 });
    } catch (error) {
      logError("webhook", `${topic} failed`, {
        shop,
        inventoryItem: level.inventory_item_id,
        error: String(error),
      });
      return new Response(null, { status: 500 });
    }
  });

async function resolveSourceBarcode(
  admin: {
    graphql: (
      query: string,
      options: { variables: Record<string, unknown> },
    ) => Promise<Response>;
  },
  inventoryItemId: number,
): Promise<string | null> {
  const response = await admin.graphql(
    `#graphql
      query SourceInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          variants(first: 1) {
            nodes {
              barcode
            }
          }
        }
      }`,
    { variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` } },
  );

  const body = (await response.json()) as {
    data?: {
      inventoryItem: {
        variants: { nodes: { barcode: string | null }[] };
      } | null;
    };
  };

  return body.data?.inventoryItem?.variants.nodes[0]?.barcode ?? null;
}

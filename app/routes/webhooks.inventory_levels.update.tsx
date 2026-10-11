import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncInventoryToDestinations } from "../inventory-sync.server";

interface InventoryLevelPayload {
  inventory_item_id?: number;
  available?: number;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  const level = payload as InventoryLevelPayload;

  if (
    typeof level.inventory_item_id !== "number" ||
    typeof level.available !== "number"
  ) {
    console.log(`[inventory] skipped ${topic} (unusable payload) for ${shop}`);
    return new Response(null, { status: 200 });
  }

  if (!admin) {
    console.warn(
      `[inventory] no admin session for ${shop}; cannot resolve item ${level.inventory_item_id}`,
    );
    return new Response(null, { status: 200 });
  }

  try {
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
      { variables: { id: `gid://shopify/InventoryItem/${level.inventory_item_id}` } },
    );

    const body = (await response.json()) as {
      data?: {
        inventoryItem: {
          variants: { nodes: { barcode: string | null }[] };
        } | null;
      };
    };

    const item = body.data?.inventoryItem;
    if (!item) {
      console.warn(
        `[inventory] source item ${level.inventory_item_id} not found on ${shop}`,
      );
      return new Response(null, { status: 200 });
    }

    await syncInventoryToDestinations({
      barcode: item.variants.nodes[0]?.barcode ?? null,
      quantity: level.available,
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(
      `[inventory] failed for ${shop} item ${level.inventory_item_id}`,
      error,
    );
    return new Response(null, { status: 500 });
  }
};

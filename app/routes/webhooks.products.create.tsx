import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  syncProductToDestination,
  type WebhookProduct,
} from "../product-sync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const product = payload as WebhookProduct;

  try {
    const result = await syncProductToDestination(product, "create");
    if (result) {
      console.log(
        `[sync] products/${topic} ${result.action} ${result.destination} product ${result.productId ?? "(none)"} (source ${shop} ${product.id})`,
      );
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(
      `[sync] products/${topic} failed for ${shop} product ${product.id}`,
      error,
    );
    return new Response(null, { status: 500 });
  }
};

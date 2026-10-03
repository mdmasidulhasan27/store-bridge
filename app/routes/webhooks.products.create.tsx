import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log("================================");
  console.log("NEW PRODUCT CREATED");
  console.log("Shop:", shop);
  console.log("Topic:", topic);
  console.log("Product ID:", payload.id);
  console.log("Product Title:", payload.title);
  console.log("================================");

  return new Response(null, { status: 200 });
};

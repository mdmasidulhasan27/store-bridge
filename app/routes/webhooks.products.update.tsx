import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const product = payload as {
    id: number;
    title: string;
    status: string;
  };

  console.log("================================");

  if (product.status === "active") {
    console.log("PRODUCT READY TO SYNC TO KENO");
    console.log("Shop:", shop);
    console.log("Topic:", topic);
    console.log("Product ID:", product.id);
    console.log("Product Title:", product.title);
    console.log("Status:", product.status);
  } else {
    console.log("PRODUCT UPDATED BUT NOT ACTIVE");
    console.log("Product:", product.title);
    console.log("Status:", product.status);
  }

  console.log("================================");

  return new Response(null, { status: 200 });
};

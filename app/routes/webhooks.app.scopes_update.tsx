import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { log, withCorrelation } from "../logger.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) =>
  withCorrelation(async () => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);

    log("webhook", `received ${topic}`, { shop });

    const current = payload.current as string[];
    if (session) {
      await db.session.update({
        where: { id: session.id },
        data: { scope: current.toString() },
      });
    }

    log("webhook", `${topic} handled`, { shop, scopes: current.toString() });

    return new Response();
  });

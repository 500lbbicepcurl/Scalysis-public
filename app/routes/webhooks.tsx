import { json } from "@remix-run/node";
import type { ActionFunction } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // Adjust this if path differs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const action: ActionFunction = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);
  const payload = await request.json();

  if (topic === "customers/data_request") {
    console.log(`📥 Data request for customer: ${payload.customer.email}`);
    // No strict action needed — just log
  }

  else if (topic === "customers/redact") {
    const email = payload.customer.email;
    console.log(`🗑️ Redact customer: ${email}`);

    await prisma.session.deleteMany({
      where: { email },
    });

    await prisma.orderRecord.deleteMany({
      where: {
        address1: {
          contains: email, // if stored here (adjust if stored elsewhere)
        },
      },
    });
  }

  else if (topic === "shop/redact") {
    console.log(`🏪 Redact shop: ${shop}`);

    await prisma.session.deleteMany({
      where: { shop },
    });

    await prisma.storeProgress.deleteMany({
      where: { shopId: shop },
    });
  }

  return json({ success: true });
};

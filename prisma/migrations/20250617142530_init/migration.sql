-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "model_status" TEXT,
    "latest_cursor" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRecord" (
    "id" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "storedomain_id" TEXT,
    "orderName" TEXT NOT NULL,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "country" TEXT,
    "zip" TEXT,
    "totalAmount" TEXT,
    "currency" TEXT,
    "awb" TEXT,
    "deliveryStatus" TEXT,
    "ml_results" DOUBLE PRECISION,
    "training_data" BOOLEAN,
    "orderDate" TIMESTAMP(3),
    "cursor" TEXT,

    CONSTRAINT "OrderRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreProgress" (
    "id" SERIAL NOT NULL,
    "shopId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "offlineToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderRecord_orderId_key" ON "OrderRecord"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreProgress_shopId_key" ON "StoreProgress"("shopId");

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { load } from "cheerio";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area
} from "recharts";
import { useState, useMemo } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";

// Helper to get UTC start and end for a given IST yyyy-mm-dd string
function getUTCFromISTDate(istDateStr) {
  // istDateStr: 'yyyy-mm-dd'
  // Start of IST day: yyyy-mm-ddT00:00:00+05:30
  // End of IST day: yyyy-mm-ddT23:59:59.999+05:30
  const [yyyy, mm, dd] = istDateStr.split('-');
  // JS Date months are 0-based
  const startIST = new Date(Date.UTC(+yyyy, +mm - 1, +dd, 0, 0, 0));
  const endIST = new Date(Date.UTC(+yyyy, +mm - 1, +dd, 23, 59, 59, 999));
  // Subtract 5.5 hours to get UTC
  const startUTC = new Date(startIST.getTime() - 5.5 * 60 * 60 * 1000);
  const endUTC = new Date(endIST.getTime() - 5.5 * 60 * 60 * 1000);
  return { startUTC, endUTC };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Fetch the store domain
  const shopQuery = `
    query {
      shop {
        myshopifyDomain
      }
    }
  `;
  const shopResponse = await admin.graphql(shopQuery);
  const shopData = await shopResponse.json();
  const storedomain_id = shopData.data.shop.myshopifyDomain;
  //this is number one fetch for shop id, this will remain i think
    // Find the session for this shop in the Session table
  const session = await prisma.session.findFirst({
    where: { shop: storedomain_id }
  });

  if (!session) {
    return json({ error: "Session not found for this store" }, { status: 404 });
  }
const dbOrders = await prisma.orderRecord.findMany({
  where: {
    storedomain_id,
    training_data: false,
    NOT: [{ ml_results: null }]
  },
  orderBy: { ml_results: 'asc' } // Sort by ml_results ascending
});

const statusOrders = dbOrders.filter(order =>
  order.deliveryStatus &&
  (
    order.deliveryStatus.toLowerCase().includes("delivered") ||
    order.deliveryStatus.toLowerCase().includes("rto")
  )
);

// Use statusOrders for your chart calculations
const totalOrders = statusOrders.length;
const chartData: ChartPoint[] = [];

// Baseline profit (0% removal)
function countStatus(orders: typeof statusOrders) {
  let delivered = 0;
  let rto = 0;
  for (const order of orders) {
    if (order.deliveryStatus && order.deliveryStatus.toLowerCase().includes('delivered')) {
      delivered++;
    }
    if (order.deliveryStatus && order.deliveryStatus.toLowerCase().includes('rto')) {
      rto++;
    }
  }
  return { delivered, rto };
}

let { delivered: baseDelivered, rto: baseRto } = countStatus(statusOrders);
let baseProfit = baseDelivered * 7 - baseRto;
chartData.push({ removalPercent: 0, profitPercent: 100 });

const deliveredRtoRatios = [];
// For 1% to 20% removal
for (let percent = 0; percent <= 100; percent++) {
  const removeCount = Math.floor((percent / 100) * totalOrders);
  const filteredOrders = statusOrders.slice(removeCount);
  const { delivered, rto } = countStatus(filteredOrders);
  const profit = delivered * 7 - rto;
  const profitPercent = baseProfit === 0 ? 0 : (profit / baseProfit) * 100;
  chartData.push({ removalPercent: percent, profitPercent });
  deliveredRtoRatios.push({
    removalPercent: percent, 
    deliveredRatio: delivered === 0 ? 0 : delivered,
    rtoRatio: rto === 0 ? 0 : rto,
    delivered,
    rto
  });
}

// // 1. Get the latest order date from your database for this store
// const latestOrder = await prisma.orderRecord.findFirst({
//   where: { storedomain_id }, // filter by store domain
//   orderBy: { orderDate: 'desc' }
// });
// const lastCreatedAt = latestOrder?.orderDate?.toISOString() || null;

// // 2. Build a Shopify query string
// let shopifyQuery = '';
// if (lastCreatedAt) {
//   shopifyQuery = `created_at:>${lastCreatedAt} gateway_names:'Cash on Delivery (COD)'`;
// } else {
//   shopifyQuery = `gateway_names:'Cash on Delivery (COD)'`;
// }

// let hasNextPage = true;
// let after = null;
// let allOrders = [];

// while (hasNextPage) { 
//   const query = `
//     query GetOrders($after: String, $query: String) {
//       orders(first: 100, after: $after, query: $query) {
//         pageInfo {
//           hasNextPage
//           endCursor
//         }
//         nodes {
//           id
//           name
//           tags
//           createdAt
//           paymentGatewayNames
//           displayFinancialStatus
//           totalPriceSet {
//             shopMoney {
//               amount
//               currencyCode
//             }
//           }
//           shippingAddress {
//             address1
//             address2
//             city
//             province
//             country
//             zip
//           }
//           fulfillments(first: 1) {
//             trackingInfo {
//               number
//             }
//           }
//         }
//       }
//     }
//   `;
 
//   const variables = { after, query: shopifyQuery };
//   const response = await admin.graphql(query, { variables });
//   const data = await response.json();
//   const ordersData = data.data.orders;
//   allOrders.push(...ordersData.nodes);
//   hasNextPage = ordersData.pageInfo.hasNextPage;
//   after = ordersData.pageInfo.endCursor;
// }



const unshipped_orders = await prisma.orderRecord.findMany({
  where: {
    storedomain_id,
    awb: null,
    ml_results: { not: null },
    OR: [
      { training_data: false },
      { training_data: null }
    ]
  },
  orderBy: { ml_results: 'asc' }
});
  return json({ orders: unshipped_orders, chartData, deliveredRtoRatios, status: session.model_status });
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Support both single and bulk
  const orderIds = formData.getAll("orderIds");
  const singleOrderId = formData.get("orderId");

  // If bulk, process all
  if (orderIds && orderIds.length > 0) {
    for (const orderId of orderIds) {
      const fullOrderId = orderId.toString().startsWith("gid://")
        ? orderId.toString()
        : `gid://shopify/Order/${orderId}`;

      const mutation = `
        mutation AddTagToOrder($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node {
              id
              ... on Order {
                tags
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = { id: fullOrderId, tags: ["Flagged by Scalysis"] };
      await admin.graphql(mutation, { variables });
    }
    return json({ success: true });
  }

  // Otherwise, fallback to single
  if (!singleOrderId) {
    return json({ error: "Missing orderId" }, { status: 400 });
  }

  const fullOrderId = singleOrderId.toString().startsWith("gid://")
    ? singleOrderId.toString()
    : `gid://shopify/Order/${singleOrderId}`;

  const mutation = `
    mutation AddTagToOrder($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node {
          id
          ... on Order {
            tags
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { id: fullOrderId, tags: ["Flagged by Scalysis"] };

  const response = await admin.graphql(mutation, { variables });
  const data = await response.json();

  if (data.errors || (data.data && data.data.tagsAdd && data.data.tagsAdd.userErrors.length > 0)) {
    return json({ error: data.errors || data.data.tagsAdd.userErrors }, { status: 500 });
  }
  
  return json({ success: true });
};

// Helper to format date to IST and display as 'dd-mm-yy hh:mm am/pm'
function formatIST(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  // Convert to IST
  const istOffset = 5.5 * 60; // in minutes
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (istOffset * 60000));
  // Format as dd-mm-yy hh:mm am/pm
  const dd = String(istDate.getDate()).padStart(2, '0');
  const mm = String(istDate.getMonth() + 1).padStart(2, '0');
  const yy = String(istDate.getFullYear()).slice(-2);
  let hours = istDate.getHours();
  const mins = String(istDate.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${dd}-${mm}-${yy} ${hours}:${mins} ${ampm}`;
}

// Helper to get IST date string in yyyy-mm-dd for input[type=date] value
function toISTInputValue(date) {
  const istOffset = 5.5 * 60; // in minutes
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (istOffset * 60000));
  return istDate.toISOString().slice(0, 10);
}

// Helper to format date to dd/mm/yyyy for input display
function toISTDisplayValue(date) {
  const istOffset = 5.5 * 60; // in minutes
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (istOffset * 60000));
  const dd = String(istDate.getDate()).padStart(2, '0');
  const mm = String(istDate.getMonth() + 1).padStart(2, '0');
  const yyyy = istDate.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export default function OrdersPage() {
  
  const { orders, chartData, deliveredRtoRatios, status } = useLoaderData();
  
  const [sliderValue, setSliderValue] = useState(4); // x-axis (removalPercent)
  const [profitPerDelivery, setProfitPerDelivery] = useState(440);
  const [lossPerRTO, setLossPerRTO] = useState(100);
  const [costPerPurchase, setCostPerPurchase] = useState(300);
  const [shippingCost, setShippingCost] = useState(80);
  const fetcher = useFetcher();
  const [flaggedOrders, setFlaggedOrders] = useState({});
  const [bulkFlagged, setBulkFlagged] = useState(false);
  const [justFlagged, setJustFlagged] = useState({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const [preset, setPreset] = useState('');
  const [filterApplied, setFilterApplied] = useState(false);
  const [filterDone, setFilterDone] = useState(false);
  const [estProfitMargin, setEstProfitMargin] = useState(5); // default 5%


  // Helper to get preset date ranges
  const getPresetRange = (preset) => {
    const now = new Date();
    const todayIST = new Date(new Date(now.getTime() + (5.5 * 60 * 60000)).toISOString().slice(0, 10));
    let from, to;
    switch (preset) {
      case 'Today':
        from = to = todayIST;
        break;
      case 'Yesterday':
        from = to = new Date(todayIST);
        from.setDate(todayIST.getDate() - 1);
        to.setDate(todayIST.getDate() - 1);
        break;
      case 'This Week': {
        const first = todayIST.getDate() - todayIST.getDay();
        from = new Date(todayIST.setDate(first));
        to = new Date();
        break;
      }
      case 'This Month':
        from = new Date(todayIST.getFullYear(), todayIST.getMonth(), 1);
        to = todayIST;
        break;
      case 'This Year':
        from = new Date(todayIST.getFullYear(), 0, 1);
        to = todayIST;
        break;
      case 'Life Time':
        from = '';
        to = '';
        break;
      default:
        from = '';
        to = '';
    }
    return {
      from: from ? toISTInputValue(from) : '',
      to: to ? toISTInputValue(to) : '',
    };
  };

  // Handle preset change
  const handlePresetChange = (e) => {
    const val = e.target.value;
    setPreset(val);
    setDateRange(getPresetRange(val));
  };

  // Handle manual date change
  const handleDateChange = (e) => {
    setPreset('');
    setDateRange({ ...dateRange, [e.target.name]: e.target.value });
  };

  // Update filteredOrders to use UTC range for IST day(s)
  const filteredOrders = useMemo(() => {
    if (!dateRange.from && !dateRange.to) return orders;
    return orders.filter(order => {
      if (!order.orderDate) return false;
      const orderUTC = new Date(order.orderDate);
      let fromUTC = null, toUTC = null;
      if (dateRange.from) {
        fromUTC = getUTCFromISTDate(dateRange.from).startUTC;
      }
      if (dateRange.to) {
        toUTC = getUTCFromISTDate(dateRange.to).endUTC;
      }
      if (fromUTC && orderUTC < fromUTC) return false;
      if (toUTC && orderUTC > toUTC) return false;
      return true;
    });
  }, [orders, dateRange]);

  // Build the dynamic chart data in the same format as before
  const dynamicChartData = useMemo(() => {
    if (!deliveredRtoRatios.length) return [];
  
    return deliveredRtoRatios.map(point => {
      const { delivered, rto, removalPercent } = point;
  
      const totalOrders = filteredOrders.length;
      const ordersToShip = Math.round(totalOrders * (100 - removalPercent) / 100);
  
      const deliveryRate = (delivered + rto) > 0
        ? delivered / (delivered + rto)
        : 0;
  
      const deliveryPakka = Math.round(ordersToShip * deliveryRate);
      const rtoPakka = ordersToShip - deliveryPakka;
  
      const estProfitImpact = (
        (deliveryPakka * profitPerDelivery) -
        (rtoPakka * lossPerRTO) -
        (totalOrders * costPerPurchase)
      );
  
      return { removalPercent, estProfitImpact };
    });
  }, [deliveredRtoRatios, profitPerDelivery, lossPerRTO, costPerPurchase, filteredOrders.length]);
  
  // Recalculate chart data based on multiplier
  // Find the matching entry for the current slider value
  const currentRatio = deliveredRtoRatios.find(
    point => point.removalPercent === sliderValue
  );

  // Calculate the shipping cost for delivered + rto at this removal percent
  // const shippingTotal = currentRatio
  //   ? (currentRatio.delivered + currentRatio.rto) * shippingCost * filteredOrders.length / 100
  //   : shippingCost * filteredOrders.length;


  // Find the chart point for the current slider value
  const selectedPoint = dynamicChartData.find(
    point => Math.round(point.removalPercent) === sliderValue
  ) || dynamicChartData[0];
  
  const selectedRatio = deliveredRtoRatios.find(
    point => point.removalPercent === sliderValue
  );
  
  // Now you can safely use selectedRatio below:
  const ordersToShip = Math.round(filteredOrders.length * (100 - selectedPoint.removalPercent) / 100);
  
  const deliveryRateAtThreshold = (selectedRatio && (selectedRatio.delivered + selectedRatio.rto) > 0)
    ? (selectedRatio.delivered / (selectedRatio.delivered + selectedRatio.rto)) * 100
    : 0;

  const deliveryPakka = Math.round(ordersToShip * deliveryRateAtThreshold / 100);
  const rtoPakka = ordersToShip - deliveryPakka;
  
  const estProfitImpact = (
    (deliveryPakka * profitPerDelivery  )
    - (rtoPakka * lossPerRTO )
    - (filteredOrders.length * costPerPurchase)
  ).toFixed(0);

  const estProfitImpactNumeric = Number(estProfitImpact); // remove `.toFixed` string formatting

  const estProfitImpactAtZeroThreshold = dynamicChartData.find(
    point => point.removalPercent === 0
  )?.estProfitImpact || 0;
  
  const estProfitImpactPercentage = estProfitImpactAtZeroThreshold === 0
    ? 0
    : (((estProfitImpactNumeric - estProfitImpactAtZeroThreshold) / Math.abs(estProfitImpactAtZeroThreshold)) * 100);

  
  const estProfitImpactWithoutCpp = (
    (deliveryPakka * profitPerDelivery  )
    - (rtoPakka * lossPerRTO )
  ).toFixed(0);

  const estProfitImpactWithoutCppNumeric = estProfitImpactNumeric + (filteredOrders.length * costPerPurchase); // remove `.toFixed` string formatting

  const estProfitPerOrderAtZeroThreshold = estProfitImpactAtZeroThreshold + (filteredOrders.length * costPerPurchase);

  const estProfitPerOrderAtZero = estProfitPerOrderAtZeroThreshold / filteredOrders.length;
  const estProfitPerOrder = estProfitImpactWithoutCppNumeric / ordersToShip;
  const estProfitPerOrderPercentage = estProfitPerOrderAtZero === 0
    ? 0
    : (((estProfitPerOrder - estProfitPerOrderAtZero) / (estProfitPerOrderAtZero)) * 100);
  


  // const selectedRatio = deliveredRtoRatios.find(
  // point => point.removalPercent === sliderValue
  // );  
  const baseRatio = deliveredRtoRatios.find(
    point => point.removalPercent === 0
  );

  // Calculate RTO ratios
  const selectedDelivered = selectedRatio ? selectedRatio.delivered : 0;
  const selectedRto = selectedRatio ? selectedRatio.rto : 0;
  const baseDelivered = baseRatio ? baseRatio.delivered : 0;
  const baseRto = baseRatio ? baseRatio.rto : 0;

  const deliveredRemoved = baseDelivered - (selectedRatio ? selectedRatio.delivered : 0);
  const rtoRemoved = baseRto - (selectedRatio ? selectedRatio.rto : 0);
  const denominator = deliveredRemoved + rtoRemoved;
  const modelAccuracy = denominator === 0 ? 0 : (100 * rtoRemoved / denominator);
  const modelAccuracyDisplay = modelAccuracy % 1 === 0 ? modelAccuracy : modelAccuracy.toFixed(1);

  const selectedRtoRatio = (selectedDelivered + selectedRto) > 0
    ? selectedRto / (selectedDelivered + selectedRto)
    : 0;

  const baseRtoRatio = (baseDelivered + baseRto) > 0
    ? baseRto / (baseDelivered + baseRto)
    : 0;

  // Calculate the percent difference relative to original RTO%
  const rtoDrop = baseRtoRatio > 0
    ? (((baseRtoRatio - selectedRtoRatio) / baseRtoRatio) * 100).toFixed(2)
    : "--";

  const showCount = useMemo(() => {
    return Math.floor(filteredOrders.length * selectedPoint.removalPercent / 100);
  }, [filteredOrders.length, selectedPoint.removalPercent]);
  const flaggedCount = showCount;

  const shippingTotal = flaggedCount * shippingCost;

  const estProfitBase = dynamicChartData[0]
  ? (dynamicChartData[0].estProfitImpact + (filteredOrders.length * costPerPurchase))
  : 0;
      const estProfitLower = estProfitBase * (1 - estProfitMargin / 100);
      const estProfitUpper = estProfitBase * (1 + estProfitMargin / 100);

      // Find all valid x <= 50 within range
      const validPoints = dynamicChartData
  .filter((point, idx) =>
    point.removalPercent <= 50 &&
    Math.abs((point.estProfitImpact + (filteredOrders.length * costPerPurchase))) >= Math.abs(estProfitLower) &&
    Math.abs((point.estProfitImpact + (filteredOrders.length * costPerPurchase))) <= Math.abs(estProfitUpper)
  );


      // Pick the max x among valid ones
      const sameProfitPoint = validPoints.length
        ? validPoints[validPoints.length - 1].removalPercent
        : null;

        const pointAtSameProfit = deliveredRtoRatios.find(
          p => p.removalPercent === sameProfitPoint
        );
        
        const ordersToShipAtSameProfit = Math.round(filteredOrders.length * (100 - sameProfitPoint) / 100);
        
        const deliveryRateAtSameProfit = (pointAtSameProfit?.delivered + pointAtSameProfit?.rto) > 0
          ? pointAtSameProfit.delivered / (pointAtSameProfit.delivered + pointAtSameProfit.rto)
          : 0;
        
        const deliveryPakkaAtSameProfit = Math.round(ordersToShipAtSameProfit * deliveryRateAtSameProfit);
        const rtoPakkaAtSameProfit = ordersToShipAtSameProfit - deliveryPakkaAtSameProfit;
        
        const estProfitWithoutCppAtSameProfit = (
          (deliveryPakkaAtSameProfit * profitPerDelivery) -
          (rtoPakkaAtSameProfit * lossPerRTO)
        );
        
        const estProfitPerOrderAtSameProfit = ordersToShipAtSameProfit > 0
          ? estProfitWithoutCppAtSameProfit / ordersToShipAtSameProfit
          : 0;
        
        const estProfitPerOrderPercentageAtSameProfit = estProfitPerOrderAtZero === 0
          ? 0
          : ((estProfitPerOrderAtSameProfit - estProfitPerOrderAtZero) / (estProfitPerOrderAtZero)) * 100;
        
        const inventoryFreedAtSameProfit = Math.floor(filteredOrders.length * (sameProfitPoint / 100));
        const capitalFreedAtSameProfit = inventoryFreedAtSameProfit * shippingCost;
             



  const statBoxValues = [
    (100 - selectedPoint.removalPercent).toFixed(2),
    shippingTotal.toLocaleString(),
    estProfitImpactPercentage,
    rtoDrop,
    filteredOrders.length,
    (filteredOrders.length * (100 - selectedPoint.removalPercent) / 100).toFixed(0),
    flaggedCount,
    ((1-baseRtoRatio)*100).toFixed(1),
    modelAccuracy % 1 === 0 ? modelAccuracy : modelAccuracy.toFixed(1),
  ];
  const statBoxNames = [
    "Order Volume Retention",
    "Fwd Shipping Saved",
    "Est Profit Impact",
    "Est. RTO Drop",
    "Total Orders",
    "Orders to Ship",
    "Flagged",
    "Current Running Delivery %",
    "Model's Accuracy",
  ];

  const statBoxSublabels = [
    "Percentage of total orders",
    "Shipping + Packaging + Returns",
    "Estimated Profits:",
    "Reduction in return rate",
    "",
    "",
    "",
    `Latest Past 20% Orders`,
    "At current Threshold",
  ];

  // --- Add threshold stat box value and labels ---
  const thresholdPercent = selectedPoint.removalPercent.toFixed(2);
  const statBoxValuesWithThreshold = [
    thresholdPercent,
    ...statBoxValues.slice(0, 4)
  ];
  const statBoxNamesWithThreshold = [
    'Threshold',
    ...statBoxNames.slice(0, 4)
  ];
  const statBoxSublabelsWithThreshold = [
    'Threshold Selected',
    ...statBoxSublabels.slice(0, 4)
  ];

  const handleBulkFlagSubmit = () => {
    setBulkFlagged(true);
  };

  const handleFlagOrderSubmit = (orderId) => {
    setJustFlagged(prev => ({ ...prev, [orderId]: true }));
  };

  // Calculate Breakeven Accuracy
  const breakevenAccuracy = (profitPerDelivery + lossPerRTO) > 0
    ? Math.round((profitPerDelivery / (profitPerDelivery + lossPerRTO)) * 100)
    : 0;

  if (status !== "ready") {
    // Show a modal or a simple message
    return (
      

    <div style={{ background: '#F9FAFB', minHeight: '100vh', color: '#111827', fontFamily: 'Inter, Manrope, sans-serif', padding: '1.2rem' }}>
      <div
        style={{
          width: "100%",
          background: "linear-gradient(90deg, #5B8DEF 0%, #2563EB 100%)",
          color: "#fff",
          padding: "1rem 0",
          textAlign: "center",
          fontWeight: 600,
          fontSize: "1.2rem",
          letterSpacing: "0.5px",
          position: "sticky",
          top: 0,
          zIndex: 1000,
          boxShadow: "0 2px 8px rgba(37,99,235,0.08)",
          borderRadius: '11px',
        }}
      >
        Fetching orders, Please wait, SPEED: 1 Order per Second
      </div>
      {/* Filter Icon and Popover */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 2, marginTop: 2 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          
          <div>
            <button
              style={{
                background: 'white',
                border: '1px solid #E5E7EB',
                borderRadius: '50%',
                width: 44,
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                cursor: 'pointer',
                transition: 'box-shadow 0.2s',
                position: 'relative',
                zIndex: 10,
              }}
              onClick={() => setFilterOpen(v => !v)}
              aria-label="Filter"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>
            </button>
            {filterOpen && (
              <div style={{
                position: 'absolute',
                right: 0,
                marginTop: 12,
                background: 'white',
                border: '1px solid #E5E7EB',
                borderRadius: 12,
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                padding: '1.2rem 1.6rem',
                zIndex: 100,
                minWidth: 208,
              }}>
                <div style={{ fontWeight: 700, fontSize: '0.8rem', marginBottom: 16, color: '#2563EB' }}>Filters</div>
                <div style={{ marginBottom: 12, fontWeight: 500, color: '#111827' }}>Date Range</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <input type="date" style={{ border: '1px solid #E5E7EB', borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.8rem' }} />
                  <span style={{ color: '#6B7280', fontWeight: 500 }}>to</span>
                  <input type="date" style={{ border: '1px solid #E5E7EB', borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.8rem' }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-start', margin: '12px 0 18px 0' }}>
        <div style={{ fontSize: '1.25rem', fontWeight: 600, color: '#2563EB', letterSpacing: 0.2 }}>
          Welcome, {orders && orders.length > 0 ? orders[0].storedomain_id : ''}
        </div>
      </div> */}
      
      <div style={{ display: 'flex', gap: '19px', marginBottom: '2.5rem' }}>
        {statBoxValuesWithThreshold.map((value, idx) => (
          <div
            key={idx}
            style={{
              flex: 1,
              background: '#FFF',
              borderRadius: '11px',
              padding: '1.6rem 1.2rem',
              textAlign: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              minHeight: '136px',
              border: '1px solid #E5E7EB',
              transition: 'box-shadow 0.2s',
              gap: 8,
            }}
          >
            <div style={{ fontSize: '0.8rem', color: '#6B7280', marginBottom: '1rem', fontWeight: 500, letterSpacing: 0.5 }}>{statBoxNamesWithThreshold[idx]}</div>
            <div style={{ fontSize: '2.6rem', fontWeight: 700, color: '#111827', letterSpacing: -1 }}>{value}%</div>
            {statBoxSublabelsWithThreshold[idx] && (
              <div style={{ fontSize: '0.8rem', color: '#6B7280', marginTop: '0.7rem', fontWeight: 500 }}>{statBoxSublabelsWithThreshold[idx]}</div>
            )}
          </div>
        ))}
      </div>

      {/* Chart and controls */}
      <div style={{ display: 'flex', gap: '26px', marginBottom: '2.5rem' }}>
        <div style={{ flex: 3, background: '#FFF', borderRadius: '13px', padding: '1.6rem', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB', position: 'relative', overflow: 'visible' }}>
          <div style={{ filter: 'drop-shadow(0 8px 32px rgba(91,141,239,0.10))', borderRadius: '13px', background: 'transparent' }}>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={dynamicChartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5B8DEF" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#FFFFFF" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis dataKey="removalPercent" stroke="#6B7280" tick={{ fontSize: 14, fontWeight: 500 }} axisLine={false} tickLine={false} />
                <YAxis domain={['auto', 'auto']} stroke="#6B7280" tick={{ fontSize: 14, fontWeight: 500 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(255,255,255,0.95)',
                    border: '1px solid #E5E7EB',
                    borderRadius: 12,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
                    color: '#111827',
                  }}
                  labelStyle={{ fontSize: 13, color: '#6B7280' }}
                  cursor={{ stroke: '#2563EB', strokeWidth: 1 }}
                />
                <Area
                  type="basis"
                  dataKey="profitPercent"
                  stroke={false}
                  fill="url(#chartGradient)"
                  fillOpacity={1}
                  isAnimationActive={true}
                />
                <Line
                  type="basis"
                  dataKey="estProfitImpact"
                  stroke="#2563EB"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, fill: '#2563EB', stroke: '#fff', strokeWidth: 2, filter: 'drop-shadow(0 0 8px #2563EB66)' }}
                  isAnimationActive={true}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={sliderValue}
            onChange={e => setSliderValue(Number(e.target.value))}
            style={{
              width: '100%',
              marginTop: '1.5rem',
              accentColor: '#2563EB',
              background: 'linear-gradient(90deg, #5B8DEF 0%, #2563EB 100%)',
              borderRadius: 8,
              height: 6,
              outline: 'none',
              boxShadow: '0 2px 8px #2563EB22',
              border: 'none',
              transition: 'background 0.2s',
            }}
          />
        </div>
        <div
          style={{
            flex: 1,
            background: '#FFF',
            borderRadius: '11px',
            padding: '1.6rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 320,
            boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
            border: '1px solid #E5E7EB',
            gap: 14,
          }}
        >
          <div style={{ width: '100%', marginBottom: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Profit per Delivery</label>
            <input
              type="number"
              value={profitPerDelivery}
              step="0.01"
              min={0}
              onChange={e => setProfitPerDelivery(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%', marginBottom: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Loss per RTO</label>
            <input
              type="number"
              value={lossPerRTO}
              step="0.01"
              min={0}
              onChange={e => setLossPerRTO(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%', marginBottom: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500, display: 'block' }}>
              Cost per Purchase
            </label>
            <span style={{ fontSize: '0.9em', color: '#6B7280', verticalAlign: 'sub', display: 'block', marginBottom: '0.2rem', fontWeight: 500 }}>
              (marketing cost already spent to get these orders)
            </span>
            <input
              type="number"
              value={costPerPurchase}
              step="0.01"
              min={0}
              onChange={e => setCostPerPurchase(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Shipping cost per order</label>
            <input
              type="number"
              value={shippingCost}
              step="0.01"
              min={0}
              onChange={e => setShippingCost(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%', marginTop: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Breakeven Accuracy</label>
            <div style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#F9FAFB', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', padding: '0.4rem 0.5rem', fontWeight: 700 }}>
              {breakevenAccuracy}%
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '19px', marginTop: '2.5rem', marginBottom: '2.5rem' }}>
        {statBoxValues.slice(4, 8).map((value, idx) => {
          const label = statBoxNames[idx + 4];
          return (
            <div
              key={idx + 4}
              style={{
                flex: 1,
                background: '#FFF',
                borderRadius: '11px',
                padding: '1.6rem 1.2rem',
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                minHeight: '136px',
                border: '1px solid #E5E7EB',
                transition: 'box-shadow 0.2s',
                gap: 8,
              }}
            >
              <div style={{ fontSize: '0.8rem', color: '#6B7280', marginBottom: '1rem', fontWeight: 500, letterSpacing: 0.5 }}>{label}</div>
              <div style={{ fontSize: '2.6rem', fontWeight: 700, color: '#111827', letterSpacing: -1 }}>{value}</div>
              {statBoxSublabels[idx + 4] && (
                <div style={{ fontSize: '0.8rem', color: '#6B7280', marginTop: '0.7rem', fontWeight: 500 }}>{statBoxSublabels[idx + 4]}</div>
              )}
              {label === 'Flagged' && (
                <fetcher.Form method="post" onSubmit={() => handleBulkFlagSubmit()}>
                  {filteredOrders
                    .slice(0, showCount)
                    .map(order => (
                      <input key={order.orderId} type="hidden" name="orderIds" value={order.orderId} />
                    ))}
                <button
                    type="submit"
                  style={{
                    marginTop: '1.2rem',
                      padding: '0.4rem 1.2rem',
                      borderRadius: '6px',
                    border: 'none',
                      background: bulkFlagged ? 'linear-gradient(90deg, #43e97b 0%, #38f9d7 100%)' : 'linear-gradient(90deg, #2563EB 0%, #5B8DEF 100%)',
                    color: '#fff',
                    fontWeight: 700,
                      fontSize: '0.8rem',
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px #2563EB22',
                    transition: 'background 0.2s',
                  }}
                    disabled={bulkFlagged}
                >
                    {bulkFlagged ? 'Done' : 'Bulk Flag'}
                </button>
                </fetcher.Form>
              )}
            </div>
          );
        })}
      </div>

      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, color: '#111827', marginBottom: '1.2rem', letterSpacing: -1 }}>Orders</h1>
      <div style={{ background: '#FFF', borderRadius: '11px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB', padding: '1.6rem', marginBottom: '2.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ color: '#6B7280', fontWeight: 600, fontSize: '0.9rem', background: 'none' }}>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Name</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Amount</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Currency</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Address</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Pincode</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Order Date</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Delivery Status</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>ML Results</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Store Domain</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Flag Order</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.slice(0, showCount).map(order => (
              <tr key={order.orderId} style={{ borderBottom: '1px solid #E5E7EB', background: 'none', transition: 'background 0.2s' }}>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.orderName}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.totalAmount}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.currency}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#6B7280', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                  {order.address1}, {order.address2}, {order.city}, {order.province}, {order.country}
                </td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.zip}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{formatIST(order.orderDate)}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.deliveryStatus}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.ml_results ?? ''}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.storedomain_id}</td>
                <td style={{ padding: '0.8rem 0.5rem' }}>
                  <fetcher.Form method="post" onSubmit={() => handleFlagOrderSubmit(order.orderId)}>
                    <input type="hidden" name="orderId" value={order.orderId} />
                    <button
                      type="submit"
                      style={{
                        padding: '0.24rem 1.2rem',
                        borderRadius: '6px',
                        border: 'none',
                        background: justFlagged[order.orderId]
                          ? 'linear-gradient(90deg, #43e97b 0%, #38f9d7 100%)'
                          : flaggedOrders[order.orderId]
                          ? '#E5E7EB'
                          : 'linear-gradient(90deg, #2563EB 0%, #5B8DEF 100%)',
                        color: justFlagged[order.orderId]
                          ? '#fff'
                          : flaggedOrders[order.orderId]
                          ? '#6B7280'
                          : '#fff',
                        fontWeight: 700,
                        fontSize: '0.8rem',
                        cursor: justFlagged[order.orderId] || flaggedOrders[order.orderId] ? 'not-allowed' : 'pointer',
                        boxShadow: justFlagged[order.orderId]
                          ? '0 2px 8px #43e97b22'
                          : flaggedOrders[order.orderId]
                          ? 'none'
                          : '0 2px 8px #2563EB22',
                        transition: 'background 0.2s',
                      }}
                      disabled={justFlagged[order.orderId] || flaggedOrders[order.orderId]}
                    >
                      {justFlagged[order.orderId] ? 'Done' : flaggedOrders[order.orderId] ? 'Done' : 'Flag Order'}
                    </button>
                  </fetcher.Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ background: '#FFF', borderRadius: '11px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB', padding: '1.6rem', marginBottom: '2.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ color: '#6B7280', fontWeight: 600, fontSize: '0.9rem', background: 'none' }}>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Removal %</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Delivered</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>RTO</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>Delivered Ratio</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500 }}>RTO Ratio</th>
            </tr>
          </thead>
          <tbody>
            {deliveredRtoRatios.map(point => (
              <tr key={point.removalPercent} style={{ borderBottom: '1px solid #E5E7EB', background: 'none', transition: 'background 0.2s' }}>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700, textAlign: 'center' }}>{point.removalPercent}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700, textAlign: 'center' }}>{point.delivered}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700, textAlign: 'center' }}>{point.rto}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 500, textAlign: 'center' }}>{(point.deliveredRatio * 100).toFixed(2)}%</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 500, textAlign: 'center' }}>{(point.rtoRatio * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
  }
  return (
    <div style={{ background: '#F9FAFB', minHeight: '100vh', color: '#111827', fontFamily: 'Inter, Manrope, sans-serif', padding: '1.2rem' }}>
      {/* Filter Icon and Popover original working */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20, marginTop: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#111827', letterSpacing: -0.2 }}>
            Welcome, {filteredOrders && filteredOrders.length > 0 ? filteredOrders[0].storedomain_id : ''}
          </div>
          <div>
            <button
              style={{
                background: 'white',
                border: '1px solid #E5E7EB',
                borderRadius: '50%',
                width: 44,
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                cursor: 'pointer',
                transition: 'box-shadow 0.2s',
                position: 'relative',
                zIndex: 10,
              }}
              onClick={() => { setFilterOpen(v => !v); setFilterDone(false); }}
              aria-label="Filter"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>
            </button>
            {filterOpen && (
              <div style={{
                position: 'absolute',
                right: 0,
                marginTop: 12,
                background: 'white',
                border: '1px solid #E5E7EB',
                borderRadius: 12,
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                padding: '1.2rem 1.6rem',
                zIndex: 100,
                minWidth: 208,
              }}>
                <div style={{ fontWeight: 700, fontSize: '0.8rem', marginBottom: 16, color: '#2563EB' }}>Filters</div>
                <div style={{ marginBottom: 12, fontWeight: 500, color: '#111827' }}>Date Range</div>
                <select value={preset} onChange={handlePresetChange} style={{ marginBottom: 12, width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid #E5E7EB', fontSize: '0.8rem' }}>
                  <option value=''>Custom</option>
                  <option value='Today'>Today</option>
                  <option value='Yesterday'>Yesterday</option>
                  <option value='This Week'>This Week</option>
                  <option value='This Month'>This Month</option>
                  <option value='This Year'>This Year</option>
                  <option value='Life Time'>Life Time</option>
                </select>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
                  <input type="date" name="from" value={dateRange.from} onChange={handleDateChange} style={{ border: '1px solid #E5E7EB', borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.8rem' }} />
                  <span style={{ color: '#6B7280', fontWeight: 500 }}>to</span>
                  <input type="date" name="to" value={dateRange.to} onChange={handleDateChange} style={{ border: '1px solid #E5E7EB', borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.8rem' }} />
                </div>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => { setFilterOpen(false); setFilterDone(false); }}
                    style={{ background: '#fff', color: '#EF4444', border: '1px solid #EF4444', borderRadius: 8, padding: '0.4rem 1.2rem', fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' }}
                  >Close</button>
                  <button
                    onClick={() => { setFilterApplied(true); setFilterDone(true); setFilterOpen(false); }}
                    style={{ background: filterDone ? 'linear-gradient(90deg, #43e97b 0%, #38f9d7 100%)' : '#2563EB', color: '#fff', border: 'none', borderRadius: 8, padding: '0.4rem 1.2rem', fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' }}
                  >{filterDone ? 'Done' : 'Apply'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-start', margin: '12px 0 18px 0' }}>
        <div style={{ fontSize: '1.25rem', fontWeight: 600, color: '#2563EB', letterSpacing: 0.2 }}>
          Welcome, {orders && orders.length > 0 ? orders[0].storedomain_id : ''}
        </div>
      </div> */}
      <div style={{ display: 'flex', gap: '19px', marginBottom: '2.5rem' }}>
  {statBoxValuesWithThreshold.map((value, idx) => (
    <div
      key={idx}
      style={{
        flex: 1,
        background: '#FFF',
        borderRadius: '11px',
        padding: '1.6rem 1.2rem',
        textAlign: 'center',
        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        minHeight: '136px',
        border: '1px solid #E5E7EB',
        transition: 'box-shadow 0.2s',
        gap: 8,
      }}
    >
      <div style={{ fontSize: '0.8rem', color: '#6B7280', marginBottom: '1rem', fontWeight: 500, letterSpacing: 0.5 }}>
        {statBoxNamesWithThreshold[idx]}
      </div>

      {/* Value display */}
      {idx === 3 ? (
        <div
          style={{
            fontSize: '2.6rem',
            fontWeight: 700,
            color: estProfitImpactPercentage < 0 ? '#AF1010' : '#10B981',
            letterSpacing: -1,
          }}
        >
          {estProfitImpactPercentage > 0 ? '+' : ''}
          {estProfitImpactPercentage.toFixed(2)}%
        </div>
      ) : (
        <div style={{ fontSize: '2.6rem', fontWeight: 700, color: '#111827', letterSpacing: -1 }}>
          {value}{[0, 1, 4].includes(idx) ? '%' : ''}
        </div>
      )}

      {/* Sublabel */}
      {statBoxSublabelsWithThreshold[idx] && (
        <div style={{ fontSize: '0.8rem', color: '#6B7280', marginTop: '0.7rem', fontWeight: 500 }}>
          {idx === 3
            ? `Estimated Profits: ${estProfitImpact}`
            : statBoxSublabelsWithThreshold[idx]}
        </div>
      )}
    </div>
  ))}
</div>


      {/* Chart and controls */}
      <div style={{ display: 'flex', gap: '26px', marginBottom: '2.5rem' }}>
        <div style={{ flex: 3, background: '#FFF', borderRadius: '13px', padding: '1.6rem', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB', position: 'relative', overflow: 'visible' }}>
          <div style={{ filter: 'drop-shadow(0 8px 32px rgba(91,141,239,0.10))', borderRadius: '13px', background: 'transparent' }}>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={dynamicChartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5B8DEF" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#FFFFFF" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis dataKey="removalPercent" stroke="#6B7280" tick={{ fontSize: 14, fontWeight: 500 }} axisLine={false} tickLine={false} />
                <YAxis domain={['auto', 'auto']} stroke="#6B7280" tick={{ fontSize: 14, fontWeight: 500 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(255,255,255,0.95)',
                    border: '1px solid #E5E7EB',
                    borderRadius: 12,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
                    color: '#111827',
                  }}
                  labelStyle={{ fontSize: 13, color: '#6B7280' }}
                  cursor={{ stroke: '#2563EB', strokeWidth: 1 }}
                />
                <Area
                  type="basis"
                  dataKey="estProfitImpact"
                  stroke={false}
                  fill="url(#chartGradient)"
                  fillOpacity={1}
                  isAnimationActive={true}
                />
                <Line
                  type="basis"
                  dataKey="estProfitImpact"
                  stroke="#2563EB"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, fill: '#2563EB', stroke: '#fff', strokeWidth: 2, filter: 'drop-shadow(0 0 8px #2563EB66)' }}
                  isAnimationActive={true}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={sliderValue}
            onChange={e => setSliderValue(Number(e.target.value))}
            style={{
              width: '100%',
              marginTop: '1.5rem',
              accentColor: '#2563EB',
              background: 'linear-gradient(90deg, #5B8DEF 0%, #2563EB 100%)',
              borderRadius: 8,
              height: 6,
              outline: 'none',
              boxShadow: '0 2px 8px #2563EB22',
              border: 'none',
              transition: 'background 0.2s',
            }}
          />
        </div>
        <div
          style={{
            flex: 1,
            background: '#FFF',
            borderRadius: '11px',
            padding: '1.6rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 320,
            boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
            border: '1px solid #E5E7EB',
            gap: 14,
          }}
        >
          <div style={{ width: '100%', marginBottom: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Profit per Delivery</label>
            <input
              type="number"
              value={profitPerDelivery}
              step="0.01"
              min={0}
              onChange={e => setProfitPerDelivery(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%', marginBottom: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Loss per RTO</label>
            <input
              type="number"
              value={lossPerRTO}
              step="0.01"
              min={0}
              onChange={e => setLossPerRTO(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%', marginBottom: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500, display: 'block' }}>
              Cost per Purchase
            </label>
            <span style={{ fontSize: '0.9em', color: '#6B7280', verticalAlign: 'sub', display: 'block', marginBottom: '0.2rem', fontWeight: 500 }}>
              (marketing cost already spent to get these orders)
            </span>
            <input
              type="number"
              value={costPerPurchase}
              step="0.01"
              min={0}
              onChange={e => setCostPerPurchase(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Shipping cost per order</label>
            <input
              type="number"
              value={shippingCost}
              step="0.01"
              min={0}
              onChange={e => setShippingCost(Number(e.target.value))}
              style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#FFF', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', outline: 'none', padding: '0.4rem 0.5rem', fontWeight: 700 }}
            />
          </div>
          <div style={{ width: '100%', marginTop: '1.2rem' }}>
            <label style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 500 }}>Breakeven Accuracy</label>
            <div style={{ fontSize: '1.8rem', width: '100%', textAlign: 'center', marginTop: '0.5rem', background: '#F9FAFB', color: '#111827', border: '1px solid #E0E0E0', borderRadius: '10px', boxShadow: '0 2px 8px rgba(37,99,235,0.04)', padding: '0.4rem 0.5rem', fontWeight: 700 }}>
              {breakevenAccuracy}%
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '19px', marginTop: '2.5rem', marginBottom: '2.5rem' }}>
        {statBoxValues.slice(4, 9).map((value, idx) => {
          const label = statBoxNames[idx + 4];
          const showPercent = (idx + 4 === 7 || idx + 4 === 8);
          const isModelAccuracy = (label === "Model's Accuracy");
          const useGradient = isModelAccuracy && Number(value) > breakevenAccuracy;
          return (
            <div
              key={idx + 4}
              style={{
                flex: 1,
                background: '#FFF',
                borderRadius: '11px',
                padding: '1.6rem 1.2rem',
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                minHeight: '136px',
                border: '1px solid #E5E7EB',
                transition: 'box-shadow 0.2s',
                gap: 8,
              }}
            >
              <div style={{ fontSize: '0.8rem', color: '#6B7280', marginBottom: '1rem', fontWeight: 500, letterSpacing: 0.5 }}>{label}</div>
              <div
        style={
          useGradient
            ? {
                fontSize: '2.6rem',
                fontWeight: 700,
                letterSpacing: -1,
                color: '#35BD63',
                // WebkitBackgroundClip: 'text',
                // WebkitTextFillColor: 'transparent',
                // backgroundClip: 'text',
                transition: 'color 0.2s',
              }
            : {
                fontSize: '2.6rem',
                fontWeight: 700,
                color: '#111827',
                letterSpacing: -1,
                transition: 'color 0.2s',
              }
        }
      >
        {value}{showPercent ? '%' : ''}
      </div>
              {statBoxSublabels[idx + 4] && (
                <div style={{ fontSize: '0.8rem', color: '#6B7280', marginTop: '0.7rem', fontWeight: 500 }}>{statBoxSublabels[idx + 4]}</div>
              )}
              {label === 'Flagged' && (
                <fetcher.Form method="post" onSubmit={() => handleBulkFlagSubmit()}>
                  {filteredOrders
                    .slice(0, showCount)
                    .map(order => (
                      <input key={order.orderId} type="hidden" name="orderIds" value={order.orderId} />
                    ))}
                <button
                    type="submit"
                  style={{
                    marginTop: '1.2rem',
                      padding: '0.4rem 1.2rem',
                      borderRadius: '6px',
                    border: 'none',
                      background: bulkFlagged ? 'linear-gradient(90deg, #43e97b 0%, #38f9d7 100%)' : 'linear-gradient(90deg, #2563EB 0%, #5B8DEF 100%)',
                    color: '#fff',
                    fontWeight: 700,
                      fontSize: '0.8rem',
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px #2563EB22',
                    transition: 'background 0.2s',
                  }}
                    disabled={bulkFlagged}
                >
                    {bulkFlagged ? 'Done' : 'Bulk Flag'}
                </button>
                </fetcher.Form>
              )}
            </div>
          );
        })}
      </div>

      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, color: '#111827', marginBottom: '1.2rem', letterSpacing: -1 }}>Orders</h1>
      <div style={{ background: '#FFF', borderRadius: '11px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB', padding: '1.6rem', marginBottom: '2.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ color: '#6B7280', fontWeight: 600, fontSize: '0.9rem', background: 'none' }}>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Name</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Amount</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Currency</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Address</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Pincode</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Order Date</th>
              {/* <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Delivery Status</th> */}
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>ML Results</th>
              {/* <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Store Domain</th> */}
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Flag Order</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.slice(0, showCount).map(order => (
              <tr key={order.orderId} style={{ borderBottom: '1px solid #E5E7EB', background: 'none', transition: 'background 0.2s' }}>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.orderName}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.totalAmount}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.currency}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#6B7280', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                  {order.address1}, {order.address2}, {order.city}, {order.province}, {order.country}
                </td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.zip}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{formatIST(order.orderDate)}</td>
                {/* <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.deliveryStatus}</td> */}
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.ml_results ?? ''}</td>
                {/* <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700 }}>{order.storedomain_id}</td> */}
                <td style={{ padding: '0.8rem 0.5rem' }}>
                  <fetcher.Form method="post" onSubmit={() => handleFlagOrderSubmit(order.orderId)}>
                    <input type="hidden" name="orderId" value={order.orderId} />
                    <button
                      type="submit"
                      style={{
                        padding: '0.24rem 1.2rem',
                        borderRadius: '6px',
                        border: 'none',
                        background: justFlagged[order.orderId]
                          ? 'linear-gradient(90deg, #43e97b 0%, #38f9d7 100%)'
                          : flaggedOrders[order.orderId]
                          ? '#E5E7EB'
                          : 'linear-gradient(90deg, #2563EB 0%, #5B8DEF 100%)',
                        color: justFlagged[order.orderId]
                          ? '#fff'
                          : flaggedOrders[order.orderId]
                          ? '#6B7280'
                          : '#fff',
                        fontWeight: 700,
                        fontSize: '0.8rem',
                        cursor: justFlagged[order.orderId] || flaggedOrders[order.orderId] ? 'not-allowed' : 'pointer',
                        boxShadow: justFlagged[order.orderId]
                          ? '0 2px 8px #43e97b22'
                          : flaggedOrders[order.orderId]
                          ? 'none'
                          : '0 2px 8px #2563EB22',
                        transition: 'background 0.2s',
                      }}
                      disabled={justFlagged[order.orderId] || flaggedOrders[order.orderId]}
                    >
                      {justFlagged[order.orderId] ? 'Done' : flaggedOrders[order.orderId] ? 'Done' : 'Flag Order'}
                    </button>
                  </fetcher.Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginBottom: '1.2rem' }}>
  <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap' }}>
    <h1 style={{ fontSize: '1.8rem', fontWeight: 700, color: '#111827', letterSpacing: -1 }}>
      While maintaining Same Profits (±
    </h1>
    <input
  type="number"
  value={estProfitMargin.toFixed(1)}  
  min={0}
  max={10}
  step={0.1}
  onChange={(e) => setEstProfitMargin(Number(e.target.value))}
  style={{
    width: '3.5rem',
    border: 'none',
    fontSize: '1.8rem',
    fontWeight: 700,
    color: '#2563EB',
    textAlign: 'right',
    outline: 'none',
    background: 'transparent',
    padding: 0,
    margin: '0 2px',
    appearance: 'textfield', // for Firefox
    MozAppearance: 'textfield', // for Firefox
    WebkitAppearance: 'none', // for Chrome/Safari
  }}
/>
    <span style={{ fontSize: '1.8rem', fontWeight: 700, color: '#111827' }}>%)
    </span>
  </div>

  <div style={{ fontSize: '0.95rem', fontWeight: 500, color: '#6B7280', marginTop: '0.3rem' }}>
    {sameProfitPoint && sameProfitPoint !== 0
      ? `Excluding CPP, At ${sameProfitPoint}% Threshold`
      : 'No Same Profit Point found'}
  </div>
</div>





      <div style={{ display: 'flex', gap: '19px', marginBottom: '2.5rem' }}>
      {[
        { label: 'Inventory Freed', value: inventoryFreedAtSameProfit },
        { label: 'Working Capital Freed', value: capitalFreedAtSameProfit.toLocaleString() },
        { label: `Profit Per Order: ₹${estProfitPerOrderAtSameProfit.toFixed(2)}`, value: (
          <span style={{ color: estProfitPerOrderPercentageAtSameProfit >= 0 ? '#10B981' : '#AF1010' }}>
            {estProfitPerOrderPercentageAtSameProfit >= 0 ? '+' : ''}
            {estProfitPerOrderPercentageAtSameProfit.toFixed(2)}%
          </span>
        ) },
      ].map((box, idx) => (
        <div
          key={idx}
          style={{
            flex: 1,
            background: '#FFF',
            borderRadius: '11px',
            padding: '1.6rem 1.2rem',
            textAlign: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            minHeight: '136px',
            border: '1px solid #E5E7EB',
            transition: 'box-shadow 0.2s',
            gap: 8,
          }}
        >
          <div style={{ fontSize: '0.8rem', color: '#6B7280', marginBottom: '1rem', fontWeight: 500, letterSpacing: 0.5 }}>
            {box.label}
          </div>
          <div style={{ fontSize: '2.6rem', fontWeight: 700, color: '#111827', letterSpacing: -1 }}>
            {box.value || 0}
          </div>
        </div>
      ))}
    </div>


      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, color: '#111827', marginBottom: '1.2rem', letterSpacing: -1 }}>Scalysis Audit -- Last 20% Order Performance</h1>
      <div style={{ background: '#FFF', borderRadius: '11px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', border: '1px solid #E5E7EB', padding: '1.6rem', marginBottom: '2.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ color: '#6B7280', fontWeight: 600, fontSize: '0.9rem', background: 'none' }}>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Removal % (Threshold)</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Delivered</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>RTO</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Delivery Rate</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>ROR (Delivered : RTO Removed)</th>
              <th style={{ padding: '0.8rem 0.5rem', borderBottom: '1px solid #E5E7EB', fontWeight: 500, textAlign: 'left' }}>Model's Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {deliveredRtoRatios.map(point => (
              <tr key={point.removalPercent} style={{ borderBottom: '1px solid #E5E7EB', background: 'none', transition: 'background 0.2s' }}>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700, textAlign: 'left' }}>{point.removalPercent}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700, textAlign: 'left' }}>{point.delivered}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 700, textAlign: 'left' }}>{point.rto}</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 500, textAlign: 'left' }}>{((point.delivered + point.rto) > 0 ? (100 * point.delivered / (point.delivered + point.rto)) : 0).toFixed(2)}%</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 500, textAlign: 'left' }}>{
    (() => {
      const deliveredRemoved = baseDelivered - point.delivered;
      const rtoRemoved = baseRto - point.rto;
      if (deliveredRemoved === 0 && rtoRemoved === 0) return '0:0';
      if (deliveredRemoved === 0) return `0:${Number(rtoRemoved)}`;
      // Format to 1 decimal, then remove trailing .0
      const rhs = Number((rtoRemoved / deliveredRemoved).toFixed(1));
      return `1:${rhs}`;
    })()
  }</td>
                <td style={{ padding: '0.8rem 0.5rem', color: '#111827', fontWeight: 500, textAlign: 'left' }}>{
                                                                                                                  (() => {
                                                                                                                    const deliveredRemoved = baseDelivered - point.delivered;
                                                                                                                    const rtoRemoved = baseRto - point.rto;
                                                                                                                    const denominator = deliveredRemoved + rtoRemoved;
                                                                                                                    if (denominator === 0) return '0%';
                                                                                                                    return `${((100 * rtoRemoved) / denominator).toFixed(1)}%`;
                                                                                                                  })()
                                                                                                                }</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
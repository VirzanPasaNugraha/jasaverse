import express from "express";
import Order from "../models/order.model.js";

const router = express.Router();

// Endpoint untuk mengambil total earnings dari semua order milik seller
router.get("/earnings/:userId", async (req, res) => {
  const { userId } = req.params; // ✅ ambil dari 'userId'
  console.log("🔥 HIT /api/earnings/", userId); // ✅ log benar

  try {
    const allOrders = await Order.find({
      sellerId: userId,
      status: { $in: ["pending", "completed"] },
    });

    const totalEarnings = allOrders.reduce((sum, order) => {
      const adminFee = order.adminFee > 0 ? order.adminFee : order.price * 0.02;
      const sellerNet = order.price - adminFee;
      return sum + sellerNet;
    }, 0);

    res.status(200).json({
      userId,
      earnings: Math.round(totalEarnings * 100) / 100,
    });
  } catch (error) {
    console.error("❌ Gagal ambil dana dari Order:", error);
    res.status(500).json({ error: "Gagal ambil dana ditahan dari Order" });
  }
});


export default router;

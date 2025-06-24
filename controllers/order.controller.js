import createError from "../utils/createError.js";
import Order from "../models/order.model.js";
import Gig from "../models/gig.model.js";
import mongoose from "mongoose";
//import Stripe from "stripe";
import dotenv from "dotenv";
import midtransClient from "midtrans-client";
import User from "../models/user.model.js";



dotenv.config({ path: './.env' });  



// Inisialisasi midtrans
const midtrans = new midtransClient.Snap({
  isProduction: false,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
});




// const IDR_TO_USD_CONVERSION_RATE = parseFloat(process.env.IDR_TO_USD_CONVERSION_RATE) || 15885;
// const stripe = new Stripe(process.env.STRIPE);

/**
 * ✅ Membuat Payment Intent untuk order baru
 */
// Controller intent untuk pengecekan status order
export const intent = async (req, res, next) => {
  try {
    const { gigId, email, address, name, buyerId } = req.body;

    const gig = await Gig.findById(gigId).lean();
    if (!gig) return res.status(404).json({ message: "Gig tidak ditemukan" });

    const order_id = "ORDER-" + Date.now();

    const transaction = await midtrans.createTransaction({
  transaction_details: {
    order_id,
    gross_amount: gig.price,
  },
  item_details: [
    {
      id: String(gigId),
      name: gig.title,
      quantity: 1,
      price: Number(gig.price),
    },
  ],
  customer_details: {
    email,
    first_name: name,
    billing_address: {
      address,
    },
  },

  // ✅ INI PENTING UNTUK WEBHOOK!
  custom_field1: String(gigId),
   custom_field2: String(buyerId),

  // ✅ Jalur webhook kamu
  notification_url: process.env.NOTIFICATION_URL,
});

    if (!transaction?.token) {
      return res.status(500).json({ message: "Gagal mendapatkan token Midtrans" });
    }

    return res.status(200).json({ token: transaction.token, orderId: order_id });
  } catch (err) {
    next(err);
  }
};

export const getAdminRevenue = async (req, res, next) => {
  try {
    const result = await Order.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, totalAdminFee: { $sum: "$adminFee" } } },
    ]);

    res.status(200).json({ totalAdminFee: result[0]?.totalAdminFee || 0 });
  } catch (err) {
    next(err);
  }
};

export const handleMidtransWebhook = async (req, res) => {
  try {
    const notif = req.body;
    const order_id = notif?.order_id;
    const transaction_status = notif?.transaction_status;

    if (!order_id || !transaction_status) {
      console.error("❌ Webhook tidak mengandung order_id atau transaction_status");
      return res.status(400).json({ message: "Invalid webhook payload" });
    }

    console.log("📩 Webhook diterima:", order_id, transaction_status);

    if (["settlement", "capture"].includes(transaction_status)) {
      let transaction;
      try {
        transaction = await midtrans.transaction.status(order_id);
        console.log("📦 Data transaksi dari Midtrans:\n", JSON.stringify(transaction, null, 2));
      } catch (err) {
        console.error("❌ Gagal ambil status Midtrans:", err.message);
        return res.status(500).json({ message: "Gagal ambil status dari Midtrans" });
      }

      const gigId = transaction.item_details?.[0]?.id || transaction.custom_field1;
      const email = transaction.customer_details?.email;
      const address = transaction.customer_details?.billing_address?.address || "";
      const name = transaction.customer_details?.first_name || "User";
      const buyerIdFromMidtrans = transaction.custom_field2;

      if (!gigId) {
        console.error("❌ gigId tidak ditemukan");
        return res.status(400).json({ message: "gigId tidak ditemukan" });
      }

      const gig = await Gig.findById(gigId);
      if (!gig) {
        console.error(`❌ Gig ${gigId} tidak ditemukan`);
        return res.status(404).json({ message: "Gig tidak ditemukan" });
      }

      let user = await User.findOne({ email });
      if (!user && email) {
        try {
          user = await User.create({
            email,
            username: name || email.split("@")[0],
            img: "",
            country: "ID",
            isSeller: false,
          });
          console.log(`👤 User baru dibuat: ${user.username}`);
        } catch (err) {
          console.error("❌ Gagal membuat user:", err.message);
        }
      }

      const buyerId = user?._id || buyerIdFromMidtrans || null;
      let order = await Order.findOne({ midtransOrderId: order_id });

      if (!order) {
        // 🔰 Buat order dengan status PENDING dulu
        try {
          order = await Order.create({
            gigId,
            title: gig.title,
            img: gig.cover,
            price: gig.price,
            sellerId: gig.userId,
            buyerId: buyerId,
            status: "pending", // ⬅️ STATUS AWAL: PENDING
            payment_intent: order_id,
            midtransToken: transaction.token,
            midtransOrderId: order_id,
            customerEmail: email,
            customerAddress: address,
            customerName: name || email?.split("@")[0] || "Pengguna",
            adminFee: Math.round(gig.price * 0.02 * 100) / 100,
          });

          console.log(`✅ Order ${order_id} dibuat dengan status pending`);
        } catch (err) {
          console.error("❌ Gagal membuat order:", err.message);
          return res.status(500).json({ message: "Gagal membuat order" });
        }
      } else if (order.status === "pending") {
        // 🔄 Ubah status ke completed dan TAHAN: sales ditambah di sini SAJA
        order.status = "completed";
        order.buyerId = order.buyerId || buyerId;
        order.customerName = name;
        order.adminFee = Math.round(order.price * 0.02 * 100) / 100;
        await order.save();

        await Gig.findByIdAndUpdate(gigId, { $inc: { sales: 1 } });
        console.log(`📈 Order ${order_id} diubah jadi completed & sales gig ${gigId} ditambah`);
      } else if (order.status === "completed") {
        console.log(`ℹ️ Order ${order_id} sudah completed sebelumnya`);
      }

      return res.status(200).json({
        message: "Order berhasil diproses",
        buyerId,
      });
    }

    console.log(`ℹ️ Status transaksi: ${transaction_status} (tidak diproses)`);
    return res.status(200).json({ message: "Transaksi bukan settlement/capture, tidak diproses" });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ message: "Gagal memproses webhook" });
  }
};

/**
 * ✅ Menghapus order  berdasarkan ID
 */
export const deleteOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return next(createError(400, "Format Order ID tidak valid"));

    const order = await Order.findByIdAndDelete(id);
    if (!order) return next(createError(404, "Pesanan tidak ditemukan"));

    res.status(200).json({ message: "Pesanan berhasil dihapus" });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Mengambil daftar order berdasarkan user (buyer/seller)
 */
export const getOrders = async (req, res, next) => {
  try {
    const filter = req.isSeller ? { sellerId: req.userId } : { buyerId: req.userId };
    const orders = await Order.find(filter)
      .populate("gigId", "title userId")
      .populate("buyerId", "username")
      .populate("sellerId", "username");

    res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
};
export const getOrderReceipt = async (req, res) => {
  try {
      const order = await Order.findById(req.params.id)
          .populate("sellerId", "username")
          .populate("buyerId", "username");

      if (!order) {
          return res.status(404).json({ message: "Order tidak ditemukan" });
      }

      res.status(200).json({
          message: "Struk order berhasil diambil",
          order,
      });
  } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Gagal mengambil data struk order" });
  }
};

/**
 * ✅ Mengambil earnings dari penjual berdasarkan ID
 */
export const getEarnings = async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return next(createError(400, "Format User ID tidak valid"));
    }

    const earnings = await Order.aggregate([
      { $match: { sellerId: new mongoose.Types.ObjectId(userId), status: "completed" } },
      { $group: { _id: null, totalEarnings: { $sum: "$price" } } }
    ]);

    res.status(200).json({
      userId,
      earnings: earnings[0]?.totalEarnings || 0
    });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Menandai order sebagai "completed"
 */
export const completeOrder = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(createError(400, "Format Order ID tidak valid"));
    }

    const order = await Order.findById(id);
    if (!order) return next(createError(404, "Order tidak ditemukan"));

    if (order.sellerId.toString() !== req.userId) {
      return next(createError(403, "Unauthorized to complete this order"));
    }

    if (order.status === "completed") {
      return res.status(400).json({ message: "Order sudah diselesaikan sebelumnya" });
    }

    order.status = "completed";
    const updatedOrder = await order.save();

    // ✅ Tambahkan sales ke Gig
    await Gig.findByIdAndUpdate(order.gigId, { $inc: { sales: 1 } });

    res.status(200).json({ message: "Order berhasil diselesaikan", updatedOrder });
  } catch (err) {
    next(err);
  }
};


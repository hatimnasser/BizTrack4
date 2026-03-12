// src/utils/database.js — BizTrack Pro v4.4
// Sprint 1 hardening:
//   WAL mode, crypto.randomUUID IDs, dbTransaction helper,
//   addSaleCart transactional, importAllData safe with pre-snapshot,
//   getSales paginated (90 days / 500 rows), sync_queue + users tables
// RULE: NO inline SQL comments (--) inside SCHEMA template literal.

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';

const DB_NAME    = 'biztrack_pro';
const DB_VERSION = 7;
let db               = null;
let sqliteConnection = null;

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export const MOVEMENT_TYPES = {
  PURCHASE:'PURCHASE', SALE:'SALE', ADJUST_IN:'ADJUST_IN',
  ADJUST_OUT:'ADJUST_OUT', DAMAGE:'DAMAGE',
  RETURN_IN:'RETURN_IN', RETURN_OUT:'RETURN_OUT', OPENING:'OPENING',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  bizName TEXT DEFAULT 'My Business',
  owner TEXT DEFAULT '',
  type TEXT DEFAULT 'General Shop',
  currency TEXT DEFAULT 'UGX',
  payTerms INTEGER DEFAULT 30,
  taxRate REAL DEFAULT 0,
  lowStock INTEGER DEFAULT 5,
  invoiceFooter TEXT DEFAULT 'Thank you for your business!',
  lastBackupAt TEXT DEFAULT '',
  supabaseUserId TEXT DEFAULT '',
  syncEnabled INTEGER DEFAULT 0,
  lastSyncAt TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Other',
  baseUnit TEXT DEFAULT 'pcs',
  purchaseUnit TEXT DEFAULT 'pcs',
  conversionFactor REAL DEFAULT 1,
  saleUnit TEXT DEFAULT 'pcs',
  unit TEXT DEFAULT 'pcs',
  unitClass TEXT DEFAULT 'each',
  wmaCost REAL DEFAULT 0,
  costPrice REAL DEFAULT 0,
  sellPrice REAL DEFAULT 0,
  stock REAL DEFAULT 0,
  reorderLevel REAL DEFAULT 5,
  supplierId TEXT,
  notes TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stock_transactions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  productId TEXT NOT NULL,
  productName TEXT NOT NULL,
  movementType TEXT NOT NULL,
  purchaseUnit TEXT NOT NULL,
  purchaseQty REAL NOT NULL,
  baseUnit TEXT NOT NULL,
  baseQty REAL NOT NULL,
  unitCost REAL NOT NULL,
  totalValue REAL NOT NULL,
  resultingBalance REAL NOT NULL,
  reference TEXT,
  userId TEXT DEFAULT 'owner',
  notes TEXT
);
CREATE TABLE IF NOT EXISTS wma_history (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  productName TEXT NOT NULL,
  purchaseQty REAL NOT NULL,
  purchaseUnit TEXT NOT NULL,
  baseUnitsAdded REAL NOT NULL,
  baseUnit TEXT NOT NULL,
  bulkCostPerPurchaseUnit REAL NOT NULL,
  newCostPerBaseUnit REAL NOT NULL,
  prevStock REAL NOT NULL,
  prevWMACost REAL NOT NULL,
  newStock REAL NOT NULL,
  newWMACost REAL NOT NULL,
  alertType TEXT NOT NULL,
  alertData TEXT,
  date TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  receiptId TEXT,
  product TEXT NOT NULL,
  category TEXT,
  saleUnit TEXT DEFAULT 'pcs',
  qty REAL DEFAULT 1,
  unitPrice REAL DEFAULT 0,
  costPrice REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  paid REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  status TEXT DEFAULT 'UNPAID',
  customer TEXT DEFAULT 'Walk-in',
  phone TEXT,
  method TEXT DEFAULT 'Cash',
  notes TEXT,
  dueDate TEXT,
  date TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL DEFAULT 0,
  method TEXT DEFAULT 'Cash',
  reference TEXT,
  date TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payables (
  id TEXT PRIMARY KEY,
  creditor TEXT NOT NULL,
  category TEXT DEFAULT 'Supplier Invoice',
  description TEXT NOT NULL,
  amount REAL DEFAULT 0,
  amountPaid REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  status TEXT DEFAULT 'UNPAID',
  dueDate TEXT,
  date TEXT DEFAULT (datetime('now')),
  notes TEXT
);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS returns_log (
  id TEXT PRIMARY KEY,
  saleId TEXT,
  product TEXT,
  qty REAL DEFAULT 1,
  refund REAL DEFAULT 0,
  reason TEXT,
  date TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  tableName TEXT NOT NULL,
  recordId TEXT,
  data TEXT,
  reason TEXT,
  userId TEXT DEFAULT 'owner',
  date TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'cashier',
  pinHash TEXT,
  recoveryHash TEXT,
  active INTEGER DEFAULT 1,
  createdAt TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  tableName TEXT NOT NULL,
  recordId TEXT NOT NULL,
  operation TEXT NOT NULL,
  data TEXT,
  synced INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (id) VALUES (1)
`;

function validateSchema() {
  const stmts = SCHEMA.split(';').map(s=>s.trim()).filter(s=>s.length>0);
  const bad   = stmts.filter(s=>!/^(CREATE|INSERT|ALTER)/i.test(s));
  if (bad.length>0) console.error('SCHEMA BUG:', bad.map(s=>s.substring(0,80)));
  return bad.length===0;
}

export async function initDB() {
  try {
    validateSchema();
    sqliteConnection = new SQLiteConnection(CapacitorSQLite);
    if (Capacitor.isNativePlatform()) {
      const ret    = await sqliteConnection.checkConnectionsConsistency();
      const isConn = (await sqliteConnection.isConnection(DB_NAME, false)).result;
      db = (ret.result && isConn)
        ? await sqliteConnection.retrieveConnection(DB_NAME, false)
        : await sqliteConnection.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    } else {
      await sqliteConnection.initWebStore();
      db = await sqliteConnection.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    }
    await db.open();

    try { await db.execute('PRAGMA journal_mode=WAL;'); } catch(_){}
    try { await db.execute('PRAGMA synchronous=NORMAL;'); } catch(_){}
    try { await db.execute('PRAGMA cache_size=-4000;'); } catch(_){}
    try { await db.execute('PRAGMA temp_store=MEMORY;'); } catch(_){}

    const stmts = SCHEMA.split(';').map(s=>s.trim()).filter(s=>s.length>0);
    for (const s of stmts) await db.execute(s+';');

    const migrations=[
      `CREATE TABLE IF NOT EXISTS payables (id TEXT PRIMARY KEY, creditor TEXT NOT NULL, category TEXT DEFAULT 'Supplier Invoice', description TEXT NOT NULL, amount REAL DEFAULT 0, amountPaid REAL DEFAULT 0, balance REAL DEFAULT 0, status TEXT DEFAULT 'UNPAID', dueDate TEXT, date TEXT DEFAULT (datetime('now')), notes TEXT)`,
      `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, tableName TEXT NOT NULL, recordId TEXT, data TEXT, reason TEXT, date TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE IF NOT EXISTS wma_history (id TEXT PRIMARY KEY, productId TEXT NOT NULL, productName TEXT NOT NULL, purchaseQty REAL NOT NULL, purchaseUnit TEXT NOT NULL, baseUnitsAdded REAL NOT NULL, baseUnit TEXT NOT NULL, bulkCostPerPurchaseUnit REAL NOT NULL, newCostPerBaseUnit REAL NOT NULL, prevStock REAL NOT NULL, prevWMACost REAL NOT NULL, newStock REAL NOT NULL, newWMACost REAL NOT NULL, alertType TEXT NOT NULL, alertData TEXT, date TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE IF NOT EXISTS stock_transactions (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, productId TEXT NOT NULL, productName TEXT NOT NULL, movementType TEXT NOT NULL, purchaseUnit TEXT NOT NULL, purchaseQty REAL NOT NULL, baseUnit TEXT NOT NULL, baseQty REAL NOT NULL, unitCost REAL NOT NULL, totalValue REAL NOT NULL, resultingBalance REAL NOT NULL, reference TEXT, userId TEXT DEFAULT 'owner', notes TEXT)`,
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT DEFAULT 'cashier', pinHash TEXT, recoveryHash TEXT, active INTEGER DEFAULT 1, createdAt TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE IF NOT EXISTS sync_queue (id TEXT PRIMARY KEY, tableName TEXT NOT NULL, recordId TEXT NOT NULL, operation TEXT NOT NULL, data TEXT, synced INTEGER DEFAULT 0, createdAt TEXT DEFAULT (datetime('now')))`,
      `ALTER TABLE inventory ADD COLUMN purchaseUnit TEXT DEFAULT 'pcs'`,
      `ALTER TABLE inventory ADD COLUMN saleUnit TEXT DEFAULT 'pcs'`,
      `ALTER TABLE inventory ADD COLUMN conversionFactor REAL DEFAULT 1`,
      `ALTER TABLE inventory ADD COLUMN baseUnit TEXT DEFAULT 'pcs'`,
      `ALTER TABLE inventory ADD COLUMN wmaCost REAL DEFAULT 0`,
      `ALTER TABLE inventory ADD COLUMN unitClass TEXT DEFAULT 'each'`,
      `ALTER TABLE inventory ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))`,
      `ALTER TABLE sales ADD COLUMN saleUnit TEXT DEFAULT 'pcs'`,
      `ALTER TABLE sales ADD COLUMN receiptId TEXT`,
      `ALTER TABLE stock_transactions ADD COLUMN movementType TEXT DEFAULT 'PURCHASE'`,
      `ALTER TABLE stock_transactions ADD COLUMN userId TEXT DEFAULT 'owner'`,
      `ALTER TABLE settings ADD COLUMN lastBackupAt TEXT DEFAULT ''`,
      `ALTER TABLE settings ADD COLUMN supabaseUserId TEXT DEFAULT ''`,
      `ALTER TABLE settings ADD COLUMN syncEnabled INTEGER DEFAULT 0`,
      `ALTER TABLE settings ADD COLUMN lastSyncAt TEXT DEFAULT ''`,
      `ALTER TABLE audit_log ADD COLUMN userId TEXT DEFAULT 'owner'`,
    ];
    for (const m of migrations){try{await db.execute(m+';');}catch(_){}}

    await db.execute(`UPDATE inventory SET wmaCost=costPrice WHERE wmaCost=0 AND costPrice>0;`);
    await db.execute(`UPDATE inventory SET baseUnit=COALESCE(NULLIF(saleUnit,''),'pcs') WHERE baseUnit='pcs' AND saleUnit!='';`);
    try{await db.execute(`UPDATE stock_transactions SET movementType=CASE type WHEN 'IN' THEN 'PURCHASE' WHEN 'OUT' THEN 'SALE' WHEN 'RETURN' THEN 'RETURN_IN' WHEN 'ADJUST' THEN 'ADJUST_IN' ELSE type END WHERE movementType='PURCHASE' AND type IS NOT NULL;`);}catch(_){}

    console.log('BizTrack DB v4.4 ready (WAL+UUID+TX+Pagination)');
    return true;
  } catch(err){ console.error('DB init failed:',err); return false; }
}

export async function dbQuery(sql,values=[]){
  if(!db){const ok=await initDB();if(!ok)throw new Error('Database unavailable');}
  const res=await db.query(sql,values);
  return res.values||[];
}
export async function dbRun(sql,values=[]){
  if(!db){const ok=await initDB();if(!ok)throw new Error('Database unavailable');}
  return await db.run(sql,values);
}

export async function dbTransaction(fn){
  if(!db){const ok=await initDB();if(!ok)throw new Error('Database unavailable');}
  try{
    await db.execute('BEGIN IMMEDIATE;');
    const result=await fn();
    await db.execute('COMMIT;');
    return result;
  }catch(err){
    try{await db.execute('ROLLBACK;');}catch(_){}
    throw err;
  }
}

async function auditLog(action,tableName,recordId,data,reason='',userId='owner'){
  await dbRun(
    `INSERT INTO audit_log (id,action,tableName,recordId,data,reason,userId,date) VALUES (?,?,?,?,?,?,?,?)`,
    [uid(),action,tableName,recordId,JSON.stringify(data),reason,userId,new Date().toISOString()]
  );
}

async function queueSync(tableName,recordId,operation,data){
  try{
    await dbRun(
      `INSERT INTO sync_queue (id,tableName,recordId,operation,data,synced,createdAt) VALUES (?,?,?,?,?,0,?)`,
      [uid(),tableName,recordId,operation,JSON.stringify(data),new Date().toISOString()]
    );
  }catch(_){}
}

export async function getPendingSyncQueue(limit=100){
  return dbQuery('SELECT * FROM sync_queue WHERE synced=0 ORDER BY createdAt ASC LIMIT ?',[limit]);
}
export async function markSynced(ids){
  if(!ids.length)return;
  const ph=ids.map(()=>'?').join(',');
  await dbRun(`UPDATE sync_queue SET synced=1 WHERE id IN (${ph})`,ids);
}

async function writeStockTx(opts){
  const{productId,productName,movementType,purchaseUnit='pcs',purchaseQty=0,
    baseUnit='pcs',baseQty,unitCost,resultingBalance,reference='',userId='owner',notes=''}=opts;
  const totalValue=Math.abs(baseQty)*(unitCost||0);
  await dbRun(
    `INSERT INTO stock_transactions (id,timestamp,productId,productName,movementType,purchaseUnit,purchaseQty,baseUnit,baseQty,unitCost,totalValue,resultingBalance,reference,userId,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uid(),new Date().toISOString(),productId,productName,movementType,
     purchaseUnit,Math.abs(purchaseQty),baseUnit,baseQty,unitCost||0,totalValue,
     resultingBalance,reference,userId,notes]
  );
}

export async function getStockLedger(productId){
  return dbQuery(`SELECT * FROM stock_transactions WHERE productId=? ORDER BY timestamp DESC LIMIT 150`,[productId]);
}
export async function getAllStockTransactions(limit=300){
  return dbQuery(
    `SELECT st.*,i.name as pname FROM stock_transactions st LEFT JOIN inventory i ON st.productId=i.id ORDER BY st.timestamp DESC LIMIT ?`,
    [limit]
  );
}

export async function addStockAdjustment(productId,adjustType,qty,reason,userId='owner'){
  if(!reason||reason.trim()==='')throw new Error('Reason is required for stock adjustments');
  if(!['ADJUST_IN','ADJUST_OUT','DAMAGE'].includes(adjustType))throw new Error('Invalid adjustment type');
  if(qty<=0)throw new Error('Quantity must be greater than 0');
  return dbTransaction(async()=>{
    const rows=await dbQuery('SELECT * FROM inventory WHERE id=?',[productId]);
    if(!rows[0])throw new Error('Product not found');
    const p=rows[0];
    const bu=p.baseUnit||'pcs',pu=p.purchaseUnit||bu,cf=p.conversionFactor||1;
    const wma=p.wmaCost||p.costPrice||0;
    const isPos=adjustType==='ADJUST_IN';
    const signed=isPos?+qty:-qty;
    const newBal=Math.max(0,(p.stock||0)+signed);
    await dbRun('UPDATE inventory SET stock=?,updatedAt=? WHERE id=?',[newBal,new Date().toISOString(),productId]);
    await writeStockTx({productId,productName:p.name,movementType:adjustType,
      purchaseUnit:pu,purchaseQty:qty/cf,baseUnit:bu,baseQty:signed,
      unitCost:wma,resultingBalance:newBal,reference:'ADJ-'+uid(),userId,notes:reason.trim()});
    await auditLog(adjustType,'inventory',productId,{qty,adjustType,prevStock:p.stock,newBal},reason,userId);
    await queueSync('inventory',productId,'UPDATE',{id:productId,stock:newBal});
    return{prevStock:p.stock,newBalance:newBal,adjustType,qty};
  });
}

export async function getSettings(){const r=await dbQuery('SELECT * FROM settings WHERE id=1');return r[0]||{};}
export async function saveSettings(s){
  await dbRun(
    `UPDATE settings SET bizName=?,owner=?,type=?,currency=?,payTerms=?,taxRate=?,lowStock=?,invoiceFooter=? WHERE id=1`,
    [s.bizName,s.owner,s.type,s.currency,s.payTerms,s.taxRate,s.lowStock,s.invoiceFooter]
  );
}
export async function updateLastBackup(){
  await dbRun(`UPDATE settings SET lastBackupAt=? WHERE id=1`,[new Date().toISOString()]);
}
export async function updateLastSync(){
  await dbRun(`UPDATE settings SET lastSyncAt=? WHERE id=1`,[new Date().toISOString()]);
}

export async function getUsers(){return dbQuery('SELECT id,name,role,active,createdAt FROM users WHERE active=1 ORDER BY name ASC');}
export async function createUser(name,role,pinHash,recoveryHash){
  const id=uid();
  await dbRun(`INSERT INTO users (id,name,role,pinHash,recoveryHash,active,createdAt) VALUES (?,?,?,?,?,1,?)`,
    [id,name,role||'cashier',pinHash,recoveryHash,new Date().toISOString()]);
  return id;
}
export async function getUserByPin(pinHash){const r=await dbQuery('SELECT * FROM users WHERE pinHash=? AND active=1 LIMIT 1',[pinHash]);return r[0]||null;}
export async function getUserByRecovery(recoveryHash){const r=await dbQuery('SELECT * FROM users WHERE recoveryHash=? AND active=1 LIMIT 1',[recoveryHash]);return r[0]||null;}
export async function updateUserPin(userId,pinHash){await dbRun('UPDATE users SET pinHash=? WHERE id=?',[pinHash,userId]);}
export async function hasOwnerAccount(){const r=await dbQuery(`SELECT id FROM users WHERE role='owner' AND active=1 LIMIT 1`);return r.length>0;}

export async function getInventory(){return dbQuery('SELECT * FROM inventory ORDER BY name ASC');}

export async function addProduct(p){
  const id=p.id||uid();
  const baseUnit=p.baseUnit||p.saleUnit||p.unit||'pcs';
  const purchaseUnit=p.purchaseUnit||baseUnit;
  const cf=p.conversionFactor||1;
  const costPerBase=p.wmaCost||p.costPrice||0;
  const unitClass=p.unitClass||'each';
  const now=new Date().toISOString();
  return dbTransaction(async()=>{
    await dbRun(
      `INSERT INTO inventory (id,name,category,baseUnit,purchaseUnit,conversionFactor,saleUnit,unit,unitClass,wmaCost,costPrice,sellPrice,stock,reorderLevel,supplierId,notes,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,p.name,p.category||'Other',baseUnit,purchaseUnit,cf,baseUnit,baseUnit,unitClass,
       costPerBase,costPerBase,p.sellPrice||0,p.stock||0,
       p.reorderLevel!=null?p.reorderLevel:5,p.supplierId||'',p.notes||'',now,now]
    );
    if((p.stock||0)>0&&costPerBase>0){
      await writeStockTx({productId:id,productName:p.name,movementType:MOVEMENT_TYPES.OPENING,
        purchaseUnit,purchaseQty:p.stock/cf,baseUnit,baseQty:p.stock,
        unitCost:costPerBase,resultingBalance:p.stock,reference:'OPENING',userId:'owner',notes:'Opening stock'});
      await dbRun(
        `INSERT INTO wma_history (id,productId,productName,purchaseQty,purchaseUnit,baseUnitsAdded,baseUnit,bulkCostPerPurchaseUnit,newCostPerBaseUnit,prevStock,prevWMACost,newStock,newWMACost,alertType,alertData,date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uid(),id,p.name,p.stock/cf,purchaseUnit,p.stock,baseUnit,costPerBase*cf,costPerBase,
         0,0,p.stock,costPerBase,'INITIAL',JSON.stringify({note:'Opening stock'}),now]
      );
    }
    await queueSync('inventory',id,'INSERT',{id,name:p.name,stock:p.stock||0});
    return id;
  });
}

export async function updateProduct(id,fields){
  const keys=Object.keys(fields);
  const vals=[...Object.values(fields),new Date().toISOString(),id];
  await dbRun(`UPDATE inventory SET ${keys.map(k=>k+'=?').join(',')},updatedAt=? WHERE id=?`,vals);
  await queueSync('inventory',id,'UPDATE',{id,...fields});
}
export async function deleteProduct(id,reason=''){
  const rows=await dbQuery('SELECT * FROM inventory WHERE id=?',[id]);
  if(rows[0])await auditLog('DELETE','inventory',id,rows[0],reason);
  await dbRun('DELETE FROM inventory WHERE id=?',[id]);
  await queueSync('inventory',id,'DELETE',{id});
}
export async function updateProductStock(id,newStock,costPrice,sellPrice){
  const u=['stock=?','updatedAt=?'],v=[newStock,new Date().toISOString()];
  if(costPrice!=null){u.push('costPrice=?','wmaCost=?');v.push(costPrice,costPrice);}
  if(sellPrice!=null){u.push('sellPrice=?');v.push(sellPrice);}
  v.push(id);
  await dbRun(`UPDATE inventory SET ${u.join(',')} WHERE id=?`,v);
}

export async function restockWithWMA(productId,purchaseQty,bulkCostPerPurchaseUnit,newSellPrice=null,userId='owner'){
  return dbTransaction(async()=>{
    const rows=await dbQuery('SELECT * FROM inventory WHERE id=?',[productId]);
    if(!rows[0])throw new Error('Product not found: '+productId);
    const p=rows[0];
    const cf=p.conversionFactor||1;
    const baseUnit=p.baseUnit||p.saleUnit||'pcs';
    const purchaseUnit=p.purchaseUnit||baseUnit;
    const baseUnitsAdded=purchaseQty*cf;
    const newCostPerBase=bulkCostPerPurchaseUnit/cf;
    const prevStock=p.stock||0,prevWMACost=p.wmaCost||p.costPrice||0;
    const currentSell=newSellPrice!=null?newSellPrice:(p.sellPrice||0);
    let newWMACost=(prevStock<=0||prevWMACost<=0)?newCostPerBase
      :(prevStock*prevWMACost+baseUnitsAdded*newCostPerBase)/(prevStock+baseUnitsAdded);
    const newStock=prevStock+baseUnitsAdded,costDelta=newWMACost-prevWMACost;
    const MIN_MARGIN=0.30;
    let alertType='NO_CHANGE',alertData={};
    const isInit=prevStock<=0||prevWMACost<=0;
    if(isInit){alertType='INITIAL';alertData={newWMACost,baseUnit,purchaseUnit,cf};}
    else if(costDelta<-0.001){
      alertType='MARGIN_GAIN';
      const om=currentSell>0?((currentSell-prevWMACost)/currentSell)*100:0;
      const nm=currentSell>0?((currentSell-newWMACost)/currentSell)*100:0;
      alertData={prevWMACost,newWMACost,costDelta,costDeltaPct:(costDelta/prevWMACost)*100,
        currentSellPrice:currentSell,oldMarginPct:+om.toFixed(2),newMarginPct:+nm.toFixed(2),
        marginGainPct:+(nm-om).toFixed(2),profitGainPerUnit:+(prevWMACost-newWMACost).toFixed(4)};
    } else if(costDelta>0.001){
      alertType='PRICE_PROTECTION';
      const ms=newWMACost/(1-MIN_MARGIN);
      const cm=currentSell>0?((currentSell-newWMACost)/currentSell)*100:-999;
      const bel=currentSell<ms;
      alertData={prevWMACost,newWMACost,costDelta,costDeltaPct:(costDelta/prevWMACost)*100,
        currentSellPrice:currentSell,minSellPrice30pct:+ms.toFixed(2),currentMarginPct:+cm.toFixed(2),
        marginFloor:MIN_MARGIN*100,isBelowFloor:bel,shortfallPct:bel?+(MIN_MARGIN*100-cm).toFixed(2):0};
    }
    const sellToSave=newSellPrice!=null?newSellPrice:p.sellPrice;
    await dbRun(`UPDATE inventory SET stock=?,wmaCost=?,costPrice=?,sellPrice=?,updatedAt=? WHERE id=?`,
      [newStock,newWMACost,newWMACost,sellToSave,new Date().toISOString(),productId]);
    await writeStockTx({productId,productName:p.name,movementType:MOVEMENT_TYPES.PURCHASE,
      purchaseUnit,purchaseQty,baseUnit,baseQty:baseUnitsAdded,unitCost:newWMACost,
      resultingBalance:newStock,reference:'RST-'+uid(),userId,
      notes:`Purchase: ${purchaseQty} ${purchaseUnit} @ ${bulkCostPerPurchaseUnit} each (WMA: ${newWMACost.toFixed(4)}/${baseUnit})`});
    await dbRun(
      `INSERT INTO wma_history (id,productId,productName,purchaseQty,purchaseUnit,baseUnitsAdded,baseUnit,bulkCostPerPurchaseUnit,newCostPerBaseUnit,prevStock,prevWMACost,newStock,newWMACost,alertType,alertData,date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid(),productId,p.name,purchaseQty,purchaseUnit,baseUnitsAdded,baseUnit,
       bulkCostPerPurchaseUnit,newCostPerBase,prevStock,prevWMACost,newStock,newWMACost,
       alertType,JSON.stringify(alertData),new Date().toISOString()]
    );
    await auditLog('RESTOCK_WMA','inventory',productId,{purchaseQty,bulkCostPerPurchaseUnit,baseUnitsAdded,newCostPerBase,prevStock,prevWMACost,newStock,newWMACost,alertType},'',userId);
    await queueSync('inventory',productId,'UPDATE',{id:productId,stock:newStock,wmaCost:newWMACost});
    return{product:{...p,stock:newStock,wmaCost:newWMACost,costPrice:newWMACost,sellPrice:sellToSave},
      purchaseQty,baseUnitsAdded,bulkCostPerPurchaseUnit,newCostPerBase,
      prevStock,prevWMACost,newStock,newWMACost,alertType,alertData,baseUnit,purchaseUnit,cf};
  });
}
export async function getWMAHistory(productId){
  return dbQuery('SELECT * FROM wma_history WHERE productId=? ORDER BY date DESC LIMIT 30',[productId]);
}

export async function getSales(limit=500,dayRange=90){
  const cutoff=new Date(Date.now()-dayRange*86400000).toISOString();
  return dbQuery(`SELECT * FROM sales WHERE date >= ? ORDER BY date DESC LIMIT ?`,[cutoff,limit]);
}
export async function getSalesPage(before,limit=200){
  return dbQuery(`SELECT * FROM sales WHERE date < ? ORDER BY date DESC LIMIT ?`,[before,limit]);
}
export async function getSalesCount(){
  const r=await dbQuery('SELECT COUNT(*) as cnt FROM sales');return r[0]?.cnt||0;
}
export async function getSaleById(id){const r=await dbQuery('SELECT * FROM sales WHERE id=?',[id]);return r[0]||null;}
export async function getSalesByReceiptId(receiptId){
  if(!receiptId)return[];
  return dbQuery('SELECT * FROM sales WHERE receiptId=? ORDER BY date ASC',[receiptId]);
}

export async function addSaleCart(cartItems,receipt){
  if(!cartItems||cartItems.length===0)throw new Error('Cart is empty');
  return dbTransaction(async()=>{
    const receiptId=receipt.receiptId||('RCP-'+uid());
    const receiptTotal=cartItems.reduce((s,i)=>s+(i.lineTotal||0),0);
    const totalPaid=receipt.totalPaid||0;
    const dueDate=receipt.dueDate||new Date(Date.now()+((receipt.payTerms||30)*86400000)).toISOString().slice(0,10);
    const now=new Date().toISOString(),userId=receipt.userId||'owner';
    const savedIds=[];
    for(const item of cartItems){
      const id=uid();
      const lineRatio=receiptTotal>0?(item.lineTotal||0)/receiptTotal:1/cartItems.length;
      const linePaid=Math.round(totalPaid*lineRatio*100)/100;
      const lineBalance=Math.max(0,(item.lineTotal||0)-linePaid);
      const status=totalPaid<=0?'UNPAID':lineBalance<=0.01?'PAID':'PARTIAL';
      await dbRun(
        `INSERT INTO sales (id,receiptId,product,category,saleUnit,qty,unitPrice,costPrice,discount,total,paid,balance,status,customer,phone,method,notes,dueDate,date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,receiptId,item.product,item.category||'',item.saleUnit||'pcs',
         item.qty,item.unitPrice,item.costPrice||0,item.discount||0,
         item.lineTotal,linePaid,lineBalance,status,
         receipt.customer||'Walk-in',receipt.phone||'',receipt.method||'Cash',
         receipt.notes||'',dueDate,now]
      );
      savedIds.push(id);
      if(item.inventoryId){
        const inv=await dbQuery('SELECT stock,wmaCost,costPrice,baseUnit,purchaseUnit,reorderLevel FROM inventory WHERE id=?',[item.inventoryId]);
        if(inv[0]){
          const newBal=Math.max(0,(inv[0].stock||0)-item.qty);
          await dbRun('UPDATE inventory SET stock=?,updatedAt=? WHERE id=?',[newBal,now,item.inventoryId]);
          await writeStockTx({productId:item.inventoryId,productName:item.product,
            movementType:MOVEMENT_TYPES.SALE,
            purchaseUnit:inv[0].purchaseUnit||inv[0].baseUnit||'pcs',purchaseQty:item.qty,
            baseUnit:inv[0].baseUnit||item.saleUnit||'pcs',baseQty:-item.qty,
            unitCost:inv[0].wmaCost||inv[0].costPrice||item.costPrice||0,
            resultingBalance:newBal,reference:receiptId,userId,
            notes:`Cart sale to ${receipt.customer||'Walk-in'} — Receipt ${receiptId}`});
          const re=inv[0].reorderLevel!=null?inv[0].reorderLevel:5;
          if(newBal<=re)await auditLog('LOW_STOCK_ALERT','inventory',item.inventoryId,{stock:newBal,reorderLevel:re,product:item.product},'',userId);
          await queueSync('inventory',item.inventoryId,'UPDATE',{id:item.inventoryId,stock:newBal});
        }
      }
      await queueSync('sales',id,'INSERT',{id,receiptId,product:item.product,total:item.lineTotal});
    }
    if(receipt.customer&&receipt.customer!=='Walk-in')await upsertCustomer(receipt.customer,receipt.phone||'');
    await auditLog('SALE_CART','sales',receiptId,{receiptId,items:cartItems.length,receiptTotal,totalPaid,customer:receipt.customer},'',userId);
    return{receiptId,savedIds,receiptTotal};
  });
}

export async function addSale(s){
  return dbTransaction(async()=>{
    const id=s.id||uid(),receiptId=s.receiptId||id;
    await dbRun(
      `INSERT INTO sales (id,receiptId,product,category,saleUnit,qty,unitPrice,costPrice,discount,total,paid,balance,status,customer,phone,method,notes,dueDate,date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,receiptId,s.product,s.category||'',s.saleUnit||'pcs',s.qty,s.unitPrice,s.costPrice||0,
       s.discount||0,s.total,s.paid||0,s.balance!=null?s.balance:s.total,s.status||'UNPAID',
       s.customer||'Walk-in',s.phone||'',s.method||'Cash',s.notes||'',
       s.dueDate||'',s.date||new Date().toISOString()]
    );
    if(s.inventoryId){
      const inv=await dbQuery('SELECT stock,wmaCost,costPrice,baseUnit,purchaseUnit FROM inventory WHERE id=?',[s.inventoryId]);
      if(inv[0]){
        const newBal=Math.max(0,(inv[0].stock||0)-s.qty);
        await dbRun('UPDATE inventory SET stock=?,updatedAt=? WHERE id=?',[newBal,new Date().toISOString(),s.inventoryId]);
        await writeStockTx({productId:s.inventoryId,productName:s.product,movementType:MOVEMENT_TYPES.SALE,
          purchaseUnit:inv[0].purchaseUnit||inv[0].baseUnit||'pcs',purchaseQty:s.qty,
          baseUnit:inv[0].baseUnit||s.saleUnit||'pcs',baseQty:-s.qty,
          unitCost:inv[0].wmaCost||inv[0].costPrice||s.costPrice||0,
          resultingBalance:newBal,reference:receiptId,userId:s.userId||'owner',
          notes:`Sale to ${s.customer||'Walk-in'} @ ${s.unitPrice} — Receipt ${receiptId}`});
      }
    }
    await queueSync('sales',id,'INSERT',{id,receiptId,product:s.product});
    return id;
  });
}

export async function recordPayment(saleId,amount){
  return dbTransaction(async()=>{
    const sale=await getSaleById(saleId);if(!sale)return null;
    const newPaid=(sale.paid||0)+amount;
    const newBalance=Math.max(0,(sale.total||0)-newPaid);
    const status=newBalance<=0?'PAID':'PARTIAL';
    await dbRun('UPDATE sales SET paid=?,balance=?,status=? WHERE id=?',[newPaid,newBalance,status,saleId]);
    await queueSync('sales',saleId,'UPDATE',{id:saleId,paid:newPaid,balance:newBalance,status});
    return{paid:newPaid,balance:newBalance,status};
  });
}
export async function recordReceiptPayment(receiptId,amount){
  return dbTransaction(async()=>{
    const items=await getSalesByReceiptId(receiptId);
    if(!items.length)return null;
    const unpaidTotal=items.reduce((s,i)=>s+(i.balance||0),0);
    if(unpaidTotal<=0)return{status:'PAID',message:'Already fully paid'};
    for(const item of items){
      if((item.balance||0)<=0)continue;
      const ratio=unpaidTotal>0?(item.balance/unpaidTotal):(1/items.length);
      const itemPay=Math.min(item.balance,amount*ratio);
      const newPaid=(item.paid||0)+itemPay;
      const newBal=Math.max(0,(item.total||0)-newPaid);
      const status=newBal<=0.01?'PAID':'PARTIAL';
      await dbRun('UPDATE sales SET paid=?,balance=?,status=? WHERE id=?',[newPaid,newBal,status,item.id]);
    }
    return{receiptId,amountApplied:amount};
  });
}
export async function deleteSale(id,reason=''){
  return dbTransaction(async()=>{
    const rows=await dbQuery('SELECT * FROM sales WHERE id=?',[id]);
    if(rows[0]){
      await auditLog('DELETE','sales',id,rows[0],reason);
      const sale=rows[0];
      if(sale.product){
        const inv=await dbQuery('SELECT id,stock,wmaCost,costPrice,baseUnit,purchaseUnit FROM inventory WHERE name=? COLLATE NOCASE',[sale.product]);
        if(inv[0]){
          const newBal=(inv[0].stock||0)+(sale.qty||0);
          await dbRun('UPDATE inventory SET stock=?,updatedAt=? WHERE id=?',[newBal,new Date().toISOString(),inv[0].id]);
          await writeStockTx({productId:inv[0].id,productName:sale.product,movementType:MOVEMENT_TYPES.ADJUST_IN,
            purchaseUnit:inv[0].purchaseUnit||inv[0].baseUnit||'pcs',purchaseQty:sale.qty||0,
            baseUnit:inv[0].baseUnit||'pcs',baseQty:sale.qty||0,
            unitCost:inv[0].wmaCost||inv[0].costPrice||sale.costPrice||0,
            resultingBalance:newBal,reference:'DEL-'+id,userId:'owner',
            notes:`Sale deleted — stock restored. Reason: ${reason||'none'}`});
          await queueSync('inventory',inv[0].id,'UPDATE',{id:inv[0].id,stock:newBal});
        }
      }
    }
    await dbRun('DELETE FROM sales WHERE id=?',[id]);
    await queueSync('sales',id,'DELETE',{id});
  });
}
export async function deleteReceiptSales(receiptId,reason=''){
  const items=await getSalesByReceiptId(receiptId);
  for(const item of items)await deleteSale(item.id,reason);
}

export async function getExpenses(){return dbQuery('SELECT * FROM expenses ORDER BY date DESC LIMIT 500');}
export async function addExpense(e){
  const id=e.id||uid();
  await dbRun(`INSERT INTO expenses (id,category,description,amount,method,reference,date) VALUES (?,?,?,?,?,?,?)`,
    [id,e.category,e.description,e.amount,e.method||'Cash',e.reference||'',e.date||new Date().toISOString()]);
  await queueSync('expenses',id,'INSERT',e);
  return id;
}
export async function deleteExpense(id,reason=''){
  const rows=await dbQuery('SELECT * FROM expenses WHERE id=?',[id]);
  if(rows[0])await auditLog('DELETE','expenses',id,rows[0],reason);
  await dbRun('DELETE FROM expenses WHERE id=?',[id]);
  await queueSync('expenses',id,'DELETE',{id});
}

export async function getPayables(){return dbQuery('SELECT * FROM payables ORDER BY date DESC');}
export async function addPayable(p){
  const id=p.id||uid();
  await dbRun(`INSERT INTO payables (id,creditor,category,description,amount,amountPaid,balance,status,dueDate,date,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id,p.creditor,p.category||'Supplier Invoice',p.description,p.amount,p.amountPaid||0,
     p.balance!=null?p.balance:p.amount,p.status||'UNPAID',p.dueDate||'',p.date||new Date().toISOString(),p.notes||'']);
  await queueSync('payables',id,'INSERT',p);
  return id;
}
export async function settlePayable(id,amount){
  return dbTransaction(async()=>{
    const rows=await dbQuery('SELECT * FROM payables WHERE id=?',[id]);if(!rows[0])return null;
    const p=rows[0];
    const newPaid=(p.amountPaid||0)+amount,newBalance=Math.max(0,(p.amount||0)-newPaid);
    const status=newBalance<=0?'PAID':'PARTIAL';
    await dbRun('UPDATE payables SET amountPaid=?,balance=?,status=? WHERE id=?',[newPaid,newBalance,status,id]);
    await queueSync('payables',id,'UPDATE',{id,amountPaid:newPaid,balance:newBalance,status});
    return{amountPaid:newPaid,balance:newBalance,status};
  });
}
export async function deletePayable(id,reason=''){
  const rows=await dbQuery('SELECT * FROM payables WHERE id=?',[id]);
  if(rows[0])await auditLog('DELETE','payables',id,rows[0],reason);
  await dbRun('DELETE FROM payables WHERE id=?',[id]);
  await queueSync('payables',id,'DELETE',{id});
}

export async function getSuppliers(){return dbQuery('SELECT * FROM suppliers ORDER BY name ASC');}
export async function addSupplier(s){
  const id=s.id||uid();
  await dbRun(`INSERT INTO suppliers (id,name,contact,phone,email,address,notes) VALUES (?,?,?,?,?,?,?)`,
    [id,s.name,s.contact||'',s.phone||'',s.email||'',s.address||'',s.notes||'']);
  await queueSync('suppliers',id,'INSERT',s);
  return id;
}
export async function deleteSupplier(id,reason=''){
  const rows=await dbQuery('SELECT * FROM suppliers WHERE id=?',[id]);
  if(rows[0])await auditLog('DELETE','suppliers',id,rows[0],reason);
  await dbRun('DELETE FROM suppliers WHERE id=?',[id]);
}

export async function getCustomers(){return dbQuery('SELECT * FROM customers ORDER BY name ASC');}
export async function upsertCustomer(name,phone){
  const ex=await dbQuery('SELECT id FROM customers WHERE name=? COLLATE NOCASE',[name]);
  if(ex.length>0)return ex[0].id;
  const id=uid();
  await dbRun('INSERT INTO customers (id,name,phone) VALUES (?,?,?)',[id,name,phone||'']);
  return id;
}

export async function getReturns(){return dbQuery('SELECT * FROM returns_log ORDER BY date DESC LIMIT 300');}
export async function addReturn(r){
  return dbTransaction(async()=>{
    const id=r.id||uid();
    await dbRun(`INSERT INTO returns_log (id,saleId,product,qty,refund,reason,date) VALUES (?,?,?,?,?,?,?)`,
      [id,r.saleId||'',r.product,r.qty,r.refund,r.reason||'',r.date||new Date().toISOString()]);
    if(r.inventoryId){
      const inv=await dbQuery('SELECT stock,wmaCost,costPrice,baseUnit,purchaseUnit FROM inventory WHERE id=?',[r.inventoryId]);
      if(inv[0]){
        const newBal=(inv[0].stock||0)+r.qty;
        await dbRun('UPDATE inventory SET stock=?,updatedAt=? WHERE id=?',[newBal,new Date().toISOString(),r.inventoryId]);
        await writeStockTx({productId:r.inventoryId,productName:r.product,movementType:MOVEMENT_TYPES.RETURN_IN,
          purchaseUnit:inv[0].purchaseUnit||inv[0].baseUnit||'pcs',purchaseQty:r.qty,
          baseUnit:inv[0].baseUnit||'pcs',baseQty:r.qty,unitCost:inv[0].wmaCost||inv[0].costPrice||0,
          resultingBalance:newBal,reference:r.saleId||id,userId:r.userId||'owner',
          notes:`Customer return — ${r.reason||'no reason'}`});
        await queueSync('inventory',r.inventoryId,'UPDATE',{id:r.inventoryId,stock:newBal});
      }
    }
    await queueSync('returns_log',id,'INSERT',r);
    return id;
  });
}

export async function getAuditLog(){return dbQuery('SELECT * FROM audit_log ORDER BY date DESC LIMIT 200');}

export async function getReportData(from,to){
  const end=to+'T23:59:59';
  return{
    sales:    await dbQuery(`SELECT * FROM sales WHERE date>=? AND date<=? ORDER BY date DESC`,[from,end]),
    expenses: await dbQuery(`SELECT * FROM expenses WHERE date>=? AND date<=? ORDER BY date DESC`,[from,end]),
    returns:  await dbQuery(`SELECT * FROM returns_log WHERE date>=? AND date<=? ORDER BY date DESC`,[from,end]),
    payables: await dbQuery(`SELECT * FROM payables WHERE date>=? AND date<=? ORDER BY date DESC`,[from,end]),
  };
}

export async function exportAllData(){
  return{
    _exportedAt:new Date().toISOString(),_version:'v4.4',
    settings:await getSettings(),
    inventory:await getInventory(),
    wmaHistory:await dbQuery('SELECT * FROM wma_history ORDER BY date DESC'),
    stockTransactions:await dbQuery('SELECT * FROM stock_transactions ORDER BY timestamp DESC'),
    sales:await dbQuery('SELECT * FROM sales ORDER BY date DESC'),
    expenses:await dbQuery('SELECT * FROM expenses ORDER BY date DESC'),
    payables:await getPayables(),suppliers:await getSuppliers(),
    customers:await getCustomers(),returns:await getReturns(),
    auditLog:await getAuditLog(),
  };
}

export async function importAllData(data){
  if(!data||typeof data!=='object')throw new Error('Invalid backup file');
  let snapshotId=null;
  try{
    const snap=await exportAllData();snapshotId=uid();
    await dbRun(
      `INSERT INTO audit_log (id,action,tableName,recordId,data,reason,userId,date) VALUES (?,?,?,?,?,?,?,?)`,
      [snapshotId,'PRE_IMPORT_SNAPSHOT','ALL',snapshotId,JSON.stringify({snapshot:snap}),'Auto-snapshot before import','owner',new Date().toISOString()]
    );
  }catch(e){console.warn('Snapshot failed:',e);}
  return dbTransaction(async()=>{
    for(const t of['sales','inventory','expenses','payables','suppliers','customers','returns_log','wma_history','stock_transactions'])
      await dbRun(`DELETE FROM ${t}`);
    for(const item of(data.inventory||[]))await addProduct(item);
    for(const item of(data.expenses||[]))await addExpense(item);
    for(const item of(data.payables||[]))await addPayable(item);
    for(const item of(data.suppliers||[]))await addSupplier(item);
    if(data.settings)await saveSettings(data.settings);
    await updateLastBackup();
    return{snapshotId,imported:{inventory:(data.inventory||[]).length,sales:(data.sales||[]).length}};
  });
}

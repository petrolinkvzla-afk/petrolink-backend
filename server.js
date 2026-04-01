const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');

dotenv.config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'energy-compliance-secret-key-2026';
const JWT_EXPIRES_IN = '30d';

// Configuración de la conexión a Supabase
const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('supabase.co') 
      ? { rejectUnauthorized: false } 
      : false
};

console.log('========================================');
console.log('DEBUG - Configuración de Base de Datos:');
console.log('DATABASE_URL configurada:', process.env.DATABASE_URL ? 'SÍ (Existe)' : 'NO (Vacía)');
if (process.env.DATABASE_URL) {
    console.log('URL empieza con:', process.env.DATABASE_URL.substring(0, 20) + '...');
}
console.log('Modo SSL:', JSON.stringify(poolConfig.ssl));
console.log('========================================');

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
    console.error('DEBUG - Error inesperado en el Pool de Postgres:', err);
});

// Configuración CORS mejorada
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'https://energy-compliance.vercel.app',
    'https://energy-compliance-git-main.vercel.app',
    'https://*.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
            callback(null, true);
        } else {
            console.log('❌ CORS bloqueado para:', origin);
            callback(new Error('No permitido por CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['Content-Length', 'X-Requested-With']
}));

app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============ PLANES DE SUSCRIPCIÓN ============
const PLANS = {
    starter: {
        name: 'Starter',
        price: 149,
        max_users: 10,
        max_permits_per_month: 200,
        features: ['firma_basica', 'dashboard_basico', 'soporte_email', 'gps_basico', 'offline', 'pdf_basico']
    },
    business: {
        name: 'Business',
        price: 499,
        max_users: 50,
        max_permits_per_month: 2000,
        features: ['firma_avanzada', 'dashboard_avanzado', 'soporte_prioritario', 'geocerca', 'offline', 'api_access', 'reportes_analitica']
    },
    enterprise: {
        name: 'Enterprise',
        price: 'Personalizado',
        max_users: 999999,
        max_permits_per_month: 999999,
        features: ['firma_legal', 'dashboard_personalizado', 'soporte_247', 'mapas_calor', 'integracion_erp', 'auditoria_entes', 'gerente_cuenta']
    }
};

// ============ FUNCIONES DE UTILIDAD ============
async function getMonthlyPermitsCount(companyId) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const result = await pool.query(
        'SELECT COUNT(*) FROM permits WHERE company_id = $1 AND created_at >= $2',
        [companyId, startOfMonth]
    );
    return parseInt(result.rows[0].count);
}

async function getCompanyUsersCount(companyId) {
    const result = await pool.query(
        'SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_active = true',
        [companyId]
    );
    return parseInt(result.rows[0].count);
}

async function getCompanyPlan(companyId) {
    const result = await pool.query(
        'SELECT subscription_plan FROM companies WHERE id = $1',
        [companyId]
    );
    return result.rows[0]?.subscription_plan || 'starter';
}

// ============ FUNCIÓN DE GENERACIÓN DE PDF ============
function generateFullPermitPDF(permit, supervisor_signature = null) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            resolve(pdfData);
        });
        
        // Encabezado
        doc.fontSize(20).font('Helvetica-Bold').text('ENERGY-COMPLIANCE', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(14).font('Helvetica').text('PERMISO DE TRABAJO SEGURO', { align: 'center' });
        doc.moveDown(0.5);
        
        // Línea separadora
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(0.5);
        
        // Estado
        if (permit.status === 'APPROVED') {
            doc.fontSize(12).font('Helvetica-Bold').fillColor('green').text('✅ APROBADO - TRABAJO SEGURO', { align: 'center' });
            doc.fillColor('black');
        } else if (permit.status === 'REJECTED') {
            doc.fontSize(12).font('Helvetica-Bold').fillColor('red').text('❌ RECHAZADO', { align: 'center' });
            doc.fillColor('black');
        } else {
            doc.fontSize(12).font('Helvetica-Bold').fillColor('orange').text('⏳ PENDIENTE DE APROBACIÓN', { align: 'center' });
            doc.fillColor('black');
        }
        doc.moveDown(0.5);
        
        // Datos del permiso
        doc.fontSize(10).font('Helvetica-Bold').text(`Número: ${permit.permit_number}`);
        doc.font('Helvetica').text(`Fecha: ${new Date(permit.created_at).toLocaleString('es-ES')}`);
        doc.text(`Riesgo: ${permit.risk_type === 'ALTURA' ? 'Trabajo en Altura' : 
                             permit.risk_type === 'ELECTRICO' ? 'Riesgo Eléctrico' :
                             permit.risk_type === 'CONFINADO' ? 'Espacio Confinado' :
                             permit.risk_type === 'CALIENTE' ? 'Trabajo en Caliente' : permit.risk_type}`);
        doc.moveDown(0.5);
        
        // Datos del personal
        doc.fontSize(12).font('Helvetica-Bold').text('DATOS DEL PERSONAL');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').text(`Técnico: ${permit.technician_name}`);
        doc.text(`Supervisor: ${permit.supervisor_name}`);
        if (permit.approved_by_name) {
            doc.text(`Aprobado por: ${permit.approved_by_name}`);
        }
        doc.moveDown(0.5);
        
        // Ubicación y descripción
        doc.fontSize(12).font('Helvetica-Bold').text('UBICACIÓN Y DESCRIPCIÓN');
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').text(`Ubicación: ${permit.work_location}`);
        doc.moveDown(0.3);
        doc.text('Descripción:');
        doc.text(permit.work_description, { width: 500, align: 'justify' });
        doc.moveDown(0.5);
        
        // Lista de verificación
        doc.fontSize(12).font('Helvetica-Bold').text('LISTA DE VERIFICACIÓN');
        doc.moveDown(0.3);
        
        const checks = permit.safety_checks;
        if (checks && typeof checks === 'object') {
            Object.entries(checks).forEach(([key, value]) => {
                const label = key.replace(/_/g, ' ').toUpperCase();
                doc.fontSize(10).font('Helvetica').text(`${value ? '✓' : '✗'} ${label}: ${value ? 'SÍ' : 'NO'}`);
            });
        }
        doc.moveDown(0.5);
        
        // FIRMA DEL TÉCNICO
        doc.fontSize(12).font('Helvetica-Bold').text('FIRMA DEL TÉCNICO');
        doc.moveDown(0.3);
        
        if (permit.technician_signature) {
            const signature = permit.technician_signature;
            doc.fontSize(10).font('Helvetica').text(`Firmado por: ${signature.signerName || 'Técnico'}`);
            doc.text(`Fecha: ${new Date(signature.timestamp).toLocaleString('es-ES')}`);
            if (signature.location) {
                doc.text(`Ubicación GPS: ${signature.location.latitude?.toFixed(6)}, ${signature.location.longitude?.toFixed(6)}`);
            }
            if (signature.signatureData) {
                try {
                    const base64Data = signature.signatureData.replace(/^data:image\/\w+;base64,/, '');
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    doc.image(imageBuffer, { width: 200, height: 80 });
                } catch (err) {
                    doc.text('(Imagen de firma disponible)');
                }
            }
        } else {
            doc.fontSize(10).text('Pendiente de firma');
        }
        doc.moveDown(0.5);
        
        // FIRMA DEL SUPERVISOR
        doc.fontSize(12).font('Helvetica-Bold').text('FIRMA DEL SUPERVISOR');
        doc.moveDown(0.3);
        
        const supervisorSig = supervisor_signature || permit.supervisor_signature;
        if (supervisorSig) {
            doc.fontSize(10).font('Helvetica').text(`Firmado por: ${supervisorSig.signerName || 'Supervisor'}`);
            doc.text(`Fecha: ${new Date(supervisorSig.timestamp).toLocaleString('es-ES')}`);
            if (supervisorSig.location) {
                doc.text(`Ubicación GPS: ${supervisorSig.location.latitude?.toFixed(6)}, ${supervisorSig.location.longitude?.toFixed(6)}`);
            }
            if (supervisorSig.signatureData) {
                try {
                    const base64Data = supervisorSig.signatureData.replace(/^data:image\/\w+;base64,/, '');
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    doc.image(imageBuffer, { width: 200, height: 80 });
                } catch (err) {
                    doc.text('(Imagen de firma disponible)');
                }
            }
        } else if (permit.status === 'PENDING') {
            doc.fontSize(10).text('Pendiente de aprobación');
        } else {
            doc.fontSize(10).text('No firmado');
        }
        doc.moveDown(0.5);
        
        // EVIDENCIA FOTOGRÁFICA
        doc.fontSize(12).font('Helvetica-Bold').text('EVIDENCIA FOTOGRÁFICA');
        doc.moveDown(0.3);
        
        const photosData = permit.photos;
        if (photosData && Array.isArray(photosData) && photosData.length > 0) {
            doc.fontSize(10).text(`${photosData.length} foto(s) adjunta(s) como evidencia del trabajo realizado:`);
            doc.moveDown(0.3);
            
            photosData.forEach((photo, index) => {
                if (index < 3 && photo.data) {
                    try {
                        const base64Data = photo.data.replace(/^data:image\/\w+;base64,/, '');
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        doc.image(imageBuffer, { width: 150, height: 100 });
                        doc.text(`Foto ${index + 1}`, { continued: true });
                        doc.moveDown(0.5);
                    } catch (err) {
                        doc.text(`Foto ${index + 1}: Imagen disponible`);
                    }
                }
            });
            if (photosData.length > 3) {
                doc.text(`... y ${photosData.length - 3} foto(s) adicional(es)`);
            }
        } else {
            doc.fontSize(10).text('No se adjuntaron fotos como evidencia');
        }
        doc.moveDown(0.5);
        
        // Código de verificación
        doc.fontSize(8).fillColor('gray').text(`Código de verificación: ${permit.permit_number.split('-')[1]}`, { align: 'center' });
        doc.moveDown(0.3);
        
        // Pie de página
        doc.fontSize(8).fillColor('gray').text(
            `Documento generado por Energy-Compliance - Sistema de Gestión de Permisos de Trabajo Seguro\n` +
            `Este documento tiene validez legal y debe ser presentado en caso de auditoría.\n` +
            `Fecha de emisión: ${new Date().toLocaleString('es-ES')}`,
            { align: 'center', width: 500 }
        );
        
        doc.end();
    });
}

// ============ MIDDLEWARES ============
const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No autorizado' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
        req.user = result.rows[0];
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido' });
    }
};

const checkRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Permiso denegado' });
        }
        next();
    };
};

const checkSubscriptionLimits = async (req, res, next) => {
    const planName = await getCompanyPlan(req.user.company_id);
    const plan = PLANS[planName];
    if (!plan) return next();
    
    if (req.path === '/users' && req.method === 'POST') {
        const companyUsers = await getCompanyUsersCount(req.user.company_id);
        if (companyUsers >= plan.max_users) {
            return res.status(403).json({ error: `Límite de usuarios alcanzado. Tu plan ${plan.name} permite hasta ${plan.max_users} usuarios.` });
        }
    }
    
    if (req.path === '/permits' && req.method === 'POST') {
        const monthlyCount = await getMonthlyPermitsCount(req.user.company_id);
        if (monthlyCount >= plan.max_permits_per_month) {
            return res.status(403).json({ error: `Límite de permisos alcanzado. Has usado ${monthlyCount} de ${plan.max_permits_per_month} este mes.` });
        }
    }
    next();
};

// ============ RUTAS DE AUTENTICACIÓN ============
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND is_active = true',
            [email]
        );
        if (result.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });
        const user = result.rows[0];
        const isValid = bcrypt.compareSync(password, user.password_hash);
        if (!isValid) return res.status(401).json({ error: 'Credenciales inválidas' });
        
        const companyResult = await pool.query(
            'SELECT name, subscription_plan FROM companies WHERE id = $1',
            [user.company_id]
        );
        const company = companyResult.rows[0];
        
        const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                email: user.email, 
                full_name: user.full_name, 
                role: user.role, 
                company_id: user.company_id, 
                company_name: company?.name || '',
                subscription_plan: company?.subscription_plan || 'starter'
            } 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { company_name, email, password, full_name } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        if (!email) {
            return res.status(400).json({ error: 'El email es requerido' });
        }
        
        const existingCompany = await client.query(
            'SELECT id FROM companies WHERE email = $1',
            [email]
        );
        
        if (existingCompany.rows.length > 0) {
            return res.status(400).json({ error: 'La empresa ya está registrada' });
        }
        
        const hash = bcrypt.hashSync(password, 10);
        
        // ✅ Crear empresa con plan STARTER
        const companyResult = await client.query(
            `INSERT INTO companies (name, email, subscription_plan, max_users, max_permits_month, created_at) 
             VALUES ($1, $2, 'starter', 10, 200, NOW()) 
             RETURNING id`,
            [company_name, email]
        );
        const companyId = companyResult.rows[0].id;
        
        const userResult = await client.query(
            `INSERT INTO users (company_id, email, password_hash, full_name, role, is_active, created_at) 
             VALUES ($1, $2, $3, $4, 'admin', true, NOW()) 
             RETURNING id, email, full_name, role`,
            [companyId, email, hash, full_name]
        );
        
        await client.query('COMMIT');
        
        const newUser = userResult.rows[0];
        const token = jwt.sign(
            { userId: newUser.id, email: newUser.email, role: newUser.role }, 
            JWT_SECRET, 
            { expiresIn: JWT_EXPIRES_IN }
        );
        
        res.json({ 
            success: true, 
            token, 
            user: { 
                ...newUser, 
                company_name, 
                subscription_plan: 'starter' 
            } 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('DETALLE DEL ERROR:', error.message);
        res.status(500).json({ error: 'Error de base de datos: ' + error.message });
    } finally {
        client.release();
    }
});

// ============ RUTAS DE SUSCRIPCIÓN ============
app.get('/api/subscription/plan', authenticate, async (req, res) => {
    try {
        const companyResult = await pool.query(
            'SELECT subscription_plan, name FROM companies WHERE id = $1',
            [req.user.company_id]
        );
        
        const company = companyResult.rows[0];
        const planName = company?.subscription_plan || 'starter';
        const plan = PLANS[planName];
        
        const currentUsers = await getCompanyUsersCount(req.user.company_id);
        const currentMonthPermits = await getMonthlyPermitsCount(req.user.company_id);
        
        res.json({ 
            success: true, 
            subscription: {
                plan: planName,
                plan_name: plan.name,
                price: plan.price,
                max_users: plan.max_users,
                max_permits_per_month: plan.max_permits_per_month,
                current_users: currentUsers,
                current_month_permits: currentMonthPermits,
                features: plan.features,
                company_name: company.name
            } 
        });
    } catch (error) {
        console.error('Error fetching subscription:', error);
        res.status(500).json({ error: 'Error al obtener suscripción' });
    }
});

app.post('/api/subscription/upgrade', authenticate, checkRole(['admin']), async (req, res) => {
    const { plan } = req.body;
    
    if (!PLANS[plan]) {
        return res.status(400).json({ error: 'Plan no válido' });
    }
    
    try {
        await pool.query(
            'UPDATE companies SET subscription_plan = $1 WHERE id = $2',
            [plan, req.user.company_id]
        );
        
        const planData = PLANS[plan];
        
        res.json({ 
            success: true, 
            message: `Plan actualizado a ${planData.name}`,
            subscription: {
                plan,
                plan_name: planData.name,
                price: planData.price,
                max_users: planData.max_users,
                max_permits_per_month: planData.max_permits_per_month
            }
        });
    } catch (error) {
        console.error('Error upgrading plan:', error);
        res.status(500).json({ error: 'Error al actualizar el plan' });
    }
});

// ============ RUTAS DE USUARIOS ============
app.get('/api/users', authenticate, checkRole(['admin']), async (req, res) => {
    const result = await pool.query(
        'SELECT id, email, full_name, role, is_active FROM users WHERE company_id = $1',
        [req.user.company_id]
    );
    res.json({ success: true, users: result.rows });
});

app.post('/api/users', authenticate, checkRole(['admin']), checkSubscriptionLimits, async (req, res) => {
    const { email, password, full_name, role } = req.body;
    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'El email ya está registrado' });
        }
        
        const hash = bcrypt.hashSync(password, 10);
        const result = await pool.query(
            'INSERT INTO users (company_id, email, password_hash, full_name, role, is_active, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id, email, full_name, role',
            [req.user.company_id, email, hash, full_name, role, true]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

// ============ RUTAS DE PERMISOS ============
// server/server.js - Actualizar POST /api/permits
app.post('/api/permits', authenticate, checkSubscriptionLimits, async (req, res) => {
    try {
        const { 
            risk_type, 
            safety_checks, 
            technician_name, 
            supervisor_name, 
            work_location, 
            work_description, 
            technician_signature, 
            photos,
            locationData  // ✅ NUEVO: datos de ubicación del trabajo
        } = req.body;
        
        const permitNumber = `PTC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const status = (req.user.role === 'admin' || req.user.role === 'supervisor') ? 'APPROVED' : 'PENDING';
        
        // ✅ Procesar ubicación del trabajo
        let workLatitude = null;
        let workLongitude = null;
        let workRadius = 100;
        let workLocationId = null;
        let locationSource = 'manual';
        
        if (locationData) {
            workLatitude = locationData.latitude;
            workLongitude = locationData.longitude;
            workRadius = locationData.radius || 100;
            locationSource = locationData.source || 'gps';
            
            if (locationData.type === 'saved' && locationData.id) {
                workLocationId = locationData.id;
            }
        }
        
        const result = await pool.query(
            `INSERT INTO permits (
                permit_number, risk_type, safety_checks, technician_name, supervisor_name, 
                work_location, work_description, status, technician_signature, photos, photos_count, 
                created_by, created_by_name, created_by_role, company_id, created_at,
                work_latitude, work_longitude, work_radius, work_location_id, location_source
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(),
                $16, $17, $18, $19, $20
            ) RETURNING *`,
            [
                permitNumber, risk_type, JSON.stringify(safety_checks || {}),
                technician_name, supervisor_name, work_location, work_description, status,
                technician_signature ? JSON.stringify(technician_signature) : null,
                JSON.stringify(photos || []), (photos || []).length,
                req.user.id, req.user.full_name, req.user.role, req.user.company_id,
                workLatitude, workLongitude, workRadius, workLocationId, locationSource
            ]
        );
        
        const newPermit = result.rows[0];
        
        // Generar PDF con firma del técnico
        const pdfBuffer = await generateFullPermitPDF(newPermit);
        const pdfBase64 = pdfBuffer.toString('base64');
        
        res.json({ 
            success: true, 
            permit: newPermit, 
            safetyEvaluation: { isSafe: true }, 
            pdf: pdfBase64,
            requiresApproval: req.user.role === 'technician',
            locationUsed: {
                latitude: workLatitude,
                longitude: workLongitude,
                radius: workRadius,
                source: locationSource
            }
        });
        
    } catch (error) {
        console.error('Error al crear permiso:', error);
        res.status(500).json({ error: 'Error al crear permiso: ' + error.message });
    }
});


// server/server.js - Actualizar GET /api/permits
app.get('/api/permits', authenticate, async (req, res) => {
    let query;
    let params;
    
    if (req.user.role === 'technician') {
        query = `SELECT 
            p.*, 
            json_build_object(
                'signerName', t.signature_data->>'signerName',
                'signatureData', t.signature_data->>'signatureData',
                'location', t.signature_data->'location',
                'timestamp', t.signature_data->>'timestamp',
                'is_within_geofence', ds.is_within_geofence,
                'distance_to_work_meters', ds.distance_to_work_meters
            ) as technician_signature,
            json_build_object(
                'signerName', s.signature_data->>'signerName',
                'signatureData', s.signature_data->>'signatureData',
                'location', s.signature_data->'location',
                'timestamp', s.signature_data->>'timestamp',
                'is_within_geofence', ds_sup.is_within_geofence,
                'distance_to_work_meters', ds_sup.distance_to_work_meters
            ) as supervisor_signature
        FROM permits p
        LEFT JOIN digital_signatures ds ON ds.permit_id = p.id AND ds.signer_type = 'technician'
        LEFT JOIN digital_signatures ds_sup ON ds_sup.permit_id = p.id AND ds_sup.signer_type = 'supervisor'
        WHERE p.created_by = $1 
        ORDER BY p.created_at DESC`;
        params = [req.user.id];
    } else {
        query = `SELECT 
            p.*, 
            json_build_object(
                'signerName', t.signature_data->>'signerName',
                'signatureData', t.signature_data->>'signatureData',
                'location', t.signature_data->'location',
                'timestamp', t.signature_data->>'timestamp',
                'is_within_geofence', ds.is_within_geofence,
                'distance_to_work_meters', ds.distance_to_work_meters
            ) as technician_signature,
            json_build_object(
                'signerName', s.signature_data->>'signerName',
                'signatureData', s.signature_data->>'signatureData',
                'location', s.signature_data->'location',
                'timestamp', s.signature_data->>'timestamp',
                'is_within_geofence', ds_sup.is_within_geofence,
                'distance_to_work_meters', ds_sup.distance_to_work_meters
            ) as supervisor_signature
        FROM permits p
        LEFT JOIN digital_signatures ds ON ds.permit_id = p.id AND ds.signer_type = 'technician'
        LEFT JOIN digital_signatures ds_sup ON ds_sup.permit_id = p.id AND ds_sup.signer_type = 'supervisor'
        WHERE p.company_id = $1 
        ORDER BY p.created_at DESC`;
        params = [req.user.company_id];
    }
    
    const result = await pool.query(query, params);
    res.json({ success: true, permits: result.rows });
});


app.put('/api/permits/:permitId/approve', authenticate, checkRole(['admin', 'supervisor']), async (req, res) => {
    const { permitId } = req.params;
    const { action, supervisor_signature, rejection_reason } = req.body;
    
    try {
        const permitResult = await pool.query(
            'SELECT * FROM permits WHERE id = $1 AND company_id = $2',
            [parseInt(permitId), req.user.company_id]
        );
        
        if (permitResult.rows.length === 0) {
            return res.status(404).json({ error: 'Permiso no encontrado' });
        }
        
        const permit = permitResult.rows[0];
        if (permit.status !== 'PENDING') {
            return res.status(400).json({ error: 'Ya fue procesado' });
        }
        
        if (action === 'approve') {
            const result = await pool.query(
                `UPDATE permits SET status = 'APPROVED', approved_by = $1, approved_by_name = $2, 
                 approved_at = NOW(), supervisor_signature = $3 WHERE id = $4 RETURNING *`,
                [req.user.id, req.user.full_name, supervisor_signature ? JSON.stringify(supervisor_signature) : null, parseInt(permitId)]
            );
            
            const approvedPermit = result.rows[0];
            
            // Generar PDF completo con ambas firmas
            const pdfBuffer = await generateFullPermitPDF(approvedPermit, supervisor_signature);
            const pdfBase64 = pdfBuffer.toString('base64');
            
            return res.json({ 
                success: true, 
                permit: approvedPermit,
                pdf: pdfBase64
            });
            
        } else if (action === 'reject') {
            const result = await pool.query(
                `UPDATE permits SET status = 'REJECTED', rejected_by = $1, rejected_by_name = $2, 
                 rejected_at = NOW(), rejection_reason = $3 WHERE id = $4 RETURNING *`,
                [req.user.id, req.user.full_name, rejection_reason || 'Sin especificar', parseInt(permitId)]
            );
            return res.json({ success: true, permit: result.rows[0] });
        } else {
            return res.status(400).json({ error: 'Acción inválida' });
        }
        
    } catch (error) {
        console.error('Error en aprobación:', error);
        return res.status(500).json({ error: 'Error al procesar la solicitud' });
    }
});

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
    let query;
    let params;
    
    if (req.user.role === 'technician') {
        query = 'SELECT * FROM permits WHERE created_by = $1';
        params = [req.user.id];
    } else {
        query = 'SELECT * FROM permits WHERE company_id = $1';
        params = [req.user.company_id];
    }
    
    const result = await pool.query(query, params);
    const permits = result.rows;
    
    res.json({ success: true, data: { 
        total_permits: permits.length, 
        approved_permits: permits.filter(p => p.status === 'APPROVED').length, 
        rejected_permits: permits.filter(p => p.status === 'REJECTED').length, 
        pending_permits: permits.filter(p => p.status === 'PENDING').length 
    } });
});

app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) FROM permits');
        res.json({ status: 'OK', message: 'Energy-Compliance API running', permits: parseInt(result.rows[0].count) });
    } catch (error) {
        res.json({ status: 'OK', message: 'Energy-Compliance API running - DB error', error: error.message });
    }
});

// server/server.js - Agregar endpoint de validación de geocerca

app.post('/api/signatures/validate', authenticate, async (req, res) => {
    const { permitId, location } = req.body;
    
    if (!permitId || !location) {
        return res.status(400).json({ error: 'Permiso y ubicación son requeridos' });
    }
    
    try {
        // Usar la función de validación SQL
        const result = await pool.query(
            `SELECT * FROM check_geofence($1, $2, $3, $4)`,
            [permitId, location.latitude, location.longitude, location.accuracy || 0]
        );
        
        const validation = result.rows[0];
        
        res.json({ 
            success: true, 
            validation: {
                within_geofence: validation.within_geofence,
                distance_meters: validation.distance_meters,
                effective_radius: validation.effective_radius,
                work_radius: validation.work_radius,
                work_latitude: validation.work_latitude,
                work_longitude: validation.work_longitude,
                message: validation.message
            }
        });
        
    } catch (error) {
        console.error('Error en validación de geocerca:', error);
        res.status(500).json({ error: 'Error al validar ubicación' });
    }
});

// server/server.js - Agregar después de las rutas de suscripción

// ============ RUTAS DE SITIOS DE TRABAJO ============
app.get('/api/work-locations', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, description, latitude, longitude, default_radius, address, is_active, created_at
             FROM work_locations 
             WHERE company_id = $1 AND is_active = true
             ORDER BY name`,
            [req.user.company_id]
        );
        res.json({ success: true, locations: result.rows });
    } catch (error) {
        console.error('Error fetching work locations:', error);
        res.status(500).json({ error: 'Error al cargar sitios de trabajo' });
    }
});

app.post('/api/work-locations', authenticate, async (req, res) => {
    const { name, description, latitude, longitude, default_radius, address } = req.body;
    
    if (!name || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Nombre y coordenadas son requeridos' });
    }
    
    try {
        const result = await pool.query(
            `INSERT INTO work_locations (company_id, name, description, latitude, longitude, default_radius, address, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [req.user.company_id, name, description, latitude, longitude, default_radius || 100, address, req.user.id]
        );
        res.json({ success: true, location: result.rows[0] });
    } catch (error) {
        console.error('Error creating work location:', error);
        res.status(500).json({ error: 'Error al crear sitio de trabajo' });
    }
});

// ✅ Exportar app para Vercel
module.exports = app;

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de Energy-Compliance activo en el puerto ${PORT}`);
    console.log(`📋 Planes disponibles: Starter (10 usuarios/200 permisos), Business (50/2000), Enterprise (Ilimitado)`);
});
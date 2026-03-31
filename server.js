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

// Middleware CORS configurado correctamente
app.use(cors({
    origin: function (origin, callback) {
        // Permitir solicitudes sin origen (como Postman)
        if (!origin) return callback(null, true);
        
        // Verificar si el origen está permitido
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

// Manejar preflight requests para TODAS las rutas
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Planes de suscripción
const PLANS = {
  free: {
    name: 'Free',
    max_users: 5,
    max_permits_per_month: 100,
    features: ['firma_basica', 'dashboard_basico', 'soporte_email']
  },
  pro: {
    name: 'Pro',
    max_users: 20,
    max_permits_per_month: 1000,
    features: ['firma_avanzada', 'dashboard_avanzado', 'soporte_prioritario', 'fotos', 'gps', 'offline']
  },
  enterprise: {
    name: 'Enterprise',
    max_users: 999999,
    max_permits_per_month: 999999,
    features: ['firma_avanzada', 'dashboard_personalizado', 'soporte_247', 'fotos', 'gps', 'offline', 'api', 'implementacion_dedicada']
  }
};

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

async function getCompanyAdmin(companyId) {
    const result = await pool.query(
        'SELECT subscription_plan, subscription_expires_at FROM users WHERE company_id = $1 AND role = $2 AND is_active = true',
        [companyId, 'admin']
    );
    return result.rows[0] || null;
}

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
    const companyAdmin = await getCompanyAdmin(req.user.company_id);
    const plan = PLANS[companyAdmin?.subscription_plan || 'free'];
    if (!plan) return next();
    
    if (req.path === '/users' && req.method === 'POST') {
        const companyUsers = await getCompanyUsersCount(req.user.company_id);
        if (companyUsers >= plan.max_users) {
            return res.status(403).json({ error: `Límite de usuarios alcanzado. Tu plan permite hasta ${plan.max_users} usuarios.` });
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
            'SELECT name FROM companies WHERE id = $1',
            [user.company_id]
        );
        const companyName = companyResult.rows[0]?.name || '';
        
        const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ success: true, token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, company_id: user.company_id, company_name: companyName, subscription_plan: user.subscription_plan || 'free' } });
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
        
        const companyResult = await client.query(
            `INSERT INTO companies (name, email, subscription_plan, max_users, max_permits_month, created_at) 
             VALUES ($1, $2, 'free', 5, 100, NOW()) 
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
                subscription_plan: 'free' 
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
    const companyAdmin = await getCompanyAdmin(req.user.company_id);
    const plan = PLANS[companyAdmin?.subscription_plan || 'free'];
    const currentUsers = await getCompanyUsersCount(req.user.company_id);
    const currentMonthPermits = await getMonthlyPermitsCount(req.user.company_id);
    res.json({ success: true, subscription: { plan: companyAdmin?.subscription_plan || 'free', plan_name: plan.name, expires_at: companyAdmin?.subscription_expires_at, max_users: plan.max_users, max_permits_per_month: plan.max_permits_per_month, current_users: currentUsers, current_month_permits: currentMonthPermits, features: plan.features } });
});

app.post('/api/subscription/upgrade', authenticate, checkRole(['admin']), async (req, res) => {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plan no válido' });
    
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    
    await pool.query(
        'UPDATE users SET subscription_plan = $1, subscription_expires_at = $2 WHERE id = $3',
        [plan, expiresAt.toISOString(), req.user.id]
    );
    
    res.json({ success: true, message: `Plan actualizado a ${PLANS[plan].name}`, subscription: { plan, plan_name: PLANS[plan].name, expires_at: expiresAt.toISOString() } });
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

// ============ RUTAS DE PERMISOS CON PDF ============
// ============ RUTAS DE PERMISOS CON PDF (CON FIRMAS Y FOTOS) ============
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
            photos 
        } = req.body;
        
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 10000);
        const permitNumber = `PTC-${timestamp}-${random}`;
        
        const status = (req.user.role === 'admin' || req.user.role === 'supervisor') ? 'APPROVED' : 'PENDING';
        
        const safetyChecksJson = safety_checks ? JSON.stringify(safety_checks) : '{}';
        const technicianSignatureJson = technician_signature ? JSON.stringify(technician_signature) : null;
        const photosJson = photos ? JSON.stringify(photos) : '[]';
        const photosCount = photos ? photos.length : 0;
        
        const result = await pool.query(
            `INSERT INTO permits (
                permit_number, risk_type, safety_checks, technician_name, supervisor_name, 
                work_location, work_description, status, technician_signature, photos, photos_count, 
                created_by, created_by_name, created_by_role, company_id, created_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW()
            ) RETURNING *`,
            [
                permitNumber, 
                risk_type, 
                safetyChecksJson,
                technician_name, 
                supervisor_name, 
                work_location, 
                work_description, 
                status, 
                technicianSignatureJson,
                photosJson,
                photosCount,
                req.user.id, 
                req.user.full_name, 
                req.user.role, 
                req.user.company_id
            ]
        );
        
        const newPermit = result.rows[0];
        
        // Generar PDF con firmas y fotos
        const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
        let buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            const pdfBase64 = pdfData.toString('base64');
            
            res.json({ 
                success: true, 
                permit: newPermit, 
                safetyEvaluation: { isSafe: true }, 
                pdf: pdfBase64,
                requiresApproval: req.user.role === 'technician' 
            });
        });
        
        // ============ CONTENIDO DEL PDF ============
        
        // Encabezado
        doc.fontSize(20)
           .font('Helvetica-Bold')
           .text('ENERGY-COMPLIANCE', { align: 'center' })
           .moveDown(0.5);
        
        doc.fontSize(14)
           .font('Helvetica')
           .text('PERMISO DE TRABAJO SEGURO', { align: 'center' })
           .moveDown(0.5);
        
        // Línea separadora
        doc.moveTo(50, doc.y)
           .lineTo(550, doc.y)
           .stroke()
           .moveDown(0.5);
        
        // Datos del permiso
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .text(`Número: ${newPermit.permit_number}`)
           .font('Helvetica')
           .text(`Fecha: ${new Date().toLocaleString('es-ES')}`)
           .text(`Riesgo: ${newPermit.risk_type === 'ALTURA' ? 'Trabajo en Altura' : 
                                 newPermit.risk_type === 'ELECTRICO' ? 'Riesgo Eléctrico' :
                                 newPermit.risk_type === 'CONFINADO' ? 'Espacio Confinado' :
                                 newPermit.risk_type === 'CALIENTE' ? 'Trabajo en Caliente' : newPermit.risk_type}`)
           .moveDown(0.5);
        
        // Datos del personal
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .text('DATOS DEL PERSONAL')
           .moveDown(0.3);
        
        doc.fontSize(10)
           .font('Helvetica')
           .text(`Técnico: ${newPermit.technician_name}`)
           .text(`Supervisor: ${newPermit.supervisor_name}`)
           .moveDown(0.5);
        
        // Ubicación y descripción
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .text('UBICACIÓN Y DESCRIPCIÓN')
           .moveDown(0.3);
        
        doc.fontSize(10)
           .font('Helvetica')
           .text(`Ubicación: ${newPermit.work_location}`)
           .moveDown(0.3)
           .text('Descripción:')
           .text(newPermit.work_description, { width: 500, align: 'justify' })
           .moveDown(0.5);
        
        // Lista de verificación
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .text('LISTA DE VERIFICACIÓN')
           .moveDown(0.3);
        
        const checks = newPermit.safety_checks;
        if (checks && typeof checks === 'object') {
            Object.entries(checks).forEach(([key, value]) => {
                const label = key.replace(/_/g, ' ').toUpperCase();
                doc.fontSize(10)
                   .font('Helvetica')
                   .text(`✓ ${label}: ${value ? 'SÍ' : 'NO'}`);
            });
        }
        doc.moveDown(0.5);
        
        // FIRMA DEL TÉCNICO
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .text('FIRMA DEL TÉCNICO')
           .moveDown(0.3);
        
        if (newPermit.technician_signature) {
            const signature = newPermit.technician_signature;
            doc.fontSize(10)
               .font('Helvetica')
               .text(`Firmado por: ${signature.signerName || 'Técnico'}`)
               .text(`Fecha: ${new Date(signature.timestamp).toLocaleString('es-ES')}`);
            
            if (signature.location) {
                doc.text(`Ubicación GPS: ${signature.location.latitude?.toFixed(6)}, ${signature.location.longitude?.toFixed(6)}`);
            }
            
            // Agregar imagen de la firma si existe
            if (signature.signatureData) {
                try {
                    const base64Data = signature.signatureData.replace(/^data:image\/\w+;base64,/, '');
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    doc.image(imageBuffer, { width: 150, height: 60, align: 'center' });
                } catch (err) {
                    doc.text('(Imagen de firma no disponible)');
                }
            }
        } else {
            doc.fontSize(10).text('Pendiente de firma');
        }
        doc.moveDown(0.5);
        
        // FIRMA DEL SUPERVISOR (si está aprobado)
        if (newPermit.status === 'APPROVED' && newPermit.supervisor_signature) {
            doc.fontSize(12)
               .font('Helvetica-Bold')
               .text('FIRMA DEL SUPERVISOR')
               .moveDown(0.3);
            
            const supervisorSig = newPermit.supervisor_signature;
            doc.fontSize(10)
               .font('Helvetica')
               .text(`Firmado por: ${supervisorSig.signerName || 'Supervisor'}`)
               .text(`Fecha: ${new Date(supervisorSig.timestamp).toLocaleString('es-ES')}`);
            
            if (supervisorSig.location) {
                doc.text(`Ubicación GPS: ${supervisorSig.location.latitude?.toFixed(6)}, ${supervisorSig.location.longitude?.toFixed(6)}`);
            }
            
            if (supervisorSig.signatureData) {
                try {
                    const base64Data = supervisorSig.signatureData.replace(/^data:image\/\w+;base64,/, '');
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    doc.image(imageBuffer, { width: 150, height: 60, align: 'center' });
                } catch (err) {
                    doc.text('(Imagen de firma no disponible)');
                }
            }
            doc.moveDown(0.5);
        }
        
        // EVIDENCIA FOTOGRÁFICA
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .text('EVIDENCIA FOTOGRÁFICA')
           .moveDown(0.3);
        
        const photosData = newPermit.photos;
        if (photosData && Array.isArray(photosData) && photosData.length > 0) {
            doc.fontSize(10)
               .text(`${photosData.length} foto(s) adjunta(s) como evidencia del trabajo realizado:`)
               .moveDown(0.3);
            
            // Intentar agregar miniaturas de fotos (máximo 3 por página para no sobrecargar)
            let yPos = doc.y;
            photosData.forEach((photo, index) => {
                if (index < 3 && photo.data) {
                    try {
                        // Verificar que el espacio en página sea suficiente
                        if (yPos > doc.page.height - 150) {
                            doc.addPage();
                            yPos = 50;
                        }
                        
                        const base64Data = photo.data.replace(/^data:image\/\w+;base64,/, '');
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        doc.image(imageBuffer, { width: 150, height: 100 });
                        doc.text(`Foto ${index + 1}`, { continued: true });
                        doc.moveDown(0.5);
                        yPos = doc.y;
                    } catch (err) {
                        doc.text(`Foto ${index + 1}: Imagen no disponible`);
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
        
        // Estado del permiso
        let statusText = '';
        let statusColor = '';
        if (newPermit.status === 'APPROVED') {
            statusText = '✅ APROBADO - TRABAJO SEGURO';
            statusColor = 'green';
        } else if (newPermit.status === 'REJECTED') {
            statusText = '❌ RECHAZADO';
            statusColor = 'red';
            if (newPermit.rejection_reason) {
                statusText += `\nMotivo: ${newPermit.rejection_reason}`;
            }
        } else {
            statusText = '⏳ PENDIENTE DE APROBACIÓN';
            statusColor = 'orange';
        }
        
        doc.fontSize(12)
           .font('Helvetica-Bold')
           .fillColor(statusColor)
           .text(statusText, { align: 'center' })
           .fillColor('black')
           .moveDown(0.5);
        
        // Código QR o número de verificación
        doc.fontSize(8)
           .fillColor('gray')
           .text(`Código de verificación: ${newPermit.permit_number.split('-')[1]}`, { align: 'center' })
           .moveDown(0.3);
        
        // Pie de página
        doc.fontSize(8)
           .fillColor('gray')
           .text(
               `Documento generado por Energy-Compliance - Sistema de Gestión de Permisos de Trabajo Seguro\n` +
               `Este documento tiene validez legal y debe ser presentado en caso de auditoría.\n` +
               `Fecha de emisión: ${new Date().toLocaleString('es-ES')}`,
               50,
               doc.page.height - 80,
               { align: 'center', width: 500 }
           );
        
        doc.end();
        
    } catch (error) {
        console.error('Error al crear permiso:', error);
        res.status(500).json({ error: 'Error al crear permiso: ' + error.message });
    }
});

app.get('/api/permits', authenticate, async (req, res) => {
    let query;
    let params;
    
    if (req.user.role === 'technician') {
        query = 'SELECT * FROM permits WHERE created_by = $1 ORDER BY created_at DESC';
        params = [req.user.id];
    } else {
        query = 'SELECT * FROM permits WHERE company_id = $1 ORDER BY created_at DESC';
        params = [req.user.company_id];
    }
    
    const result = await pool.query(query, params);
    res.json({ success: true, permits: result.rows });
});

app.put('/api/permits/:permitId/approve', authenticate, checkRole(['admin', 'supervisor']), async (req, res) => {
    const { permitId } = req.params;
    const { action, supervisor_signature, rejection_reason } = req.body;
    
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
        
        // Generar PDF con firma del supervisor
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        let buffers = [];
        
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            const pdfBase64 = pdfData.toString('base64');
            
            res.json({ 
                success: true, 
                permit: approvedPermit,
                pdf: pdfBase64
            });
        });
        
        // Contenido del PDF aprobado (similar al anterior pero con firma de supervisor)
        doc.fontSize(20).font('Helvetica-Bold').text('ENERGY-COMPLIANCE', { align: 'center' }).moveDown(0.5);
        doc.fontSize(14).text('PERMISO DE TRABAJO SEGURO - APROBADO', { align: 'center' }).moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(0.5);
        
        doc.fontSize(10).font('Helvetica-Bold').text(`Número: ${approvedPermit.permit_number}`);
        doc.font('Helvetica').text(`Fecha aprobación: ${new Date().toLocaleString('es-ES')}`);
        doc.text(`Aprobado por: ${approvedPermit.approved_by_name}`);
        
        // Agregar firma del supervisor
        if (supervisor_signature && supervisor_signature.signatureData) {
            doc.moveDown(0.5);
            doc.fontSize(10).font('Helvetica-Bold').text('Firma del Supervisor:');
            try {
                const base64Data = supervisor_signature.signatureData.replace(/^data:image\/\w+;base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                doc.image(imageBuffer, { width: 150, height: 60 });
            } catch (err) {
                doc.text('(Firma digital registrada)');
            }
        }
        
        doc.end();
        
    } else if (action === 'reject') {
        const result = await pool.query(
            `UPDATE permits SET status = 'REJECTED', rejected_by = $1, rejected_by_name = $2, 
             rejected_at = NOW(), rejection_reason = $3 WHERE id = $4 RETURNING *`,
            [req.user.id, req.user.full_name, rejection_reason || 'Sin especificar', parseInt(permitId)]
        );
        return res.json({ success: true, permit: result.rows[0] });
    }
    res.status(400).json({ error: 'Acción inválida' });
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

// ✅ Exportar app para Vercel
module.exports = app;

const PORT = process.env.PORT || 3001;

// Escuchamos en 0.0.0.0 para que Railway pueda redirigir el tráfico
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de Petrolinkvzla activo en el puerto ${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🔗 Local: http://localhost:${PORT}`);
    }
});
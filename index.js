import express from 'express';
import cors from 'cors';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/api.js';
import { computeCheck } from 'telegram/Password.js';
import { createClient } from '@supabase/supabase-js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const ADMIN_SESSION_STRING = process.env.TELEGRAM_ADMIN_SESSION_STRING;
const ADMIN_2FA_PASSWORD = process.env.TELEGRAM_ADMIN_2FA_PASSWORD;
const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_SECRET = process.env.API_SECRET || 'change-me-in-production';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log('🚀 Starting Telegram Transfer Service...');
console.log('📋 Configuration Check:');
console.log('- Session String:', ADMIN_SESSION_STRING ? '✅ Set' : '❌ Missing');
console.log('- 2FA Password:', ADMIN_2FA_PASSWORD ? '✅ Set' : '❌ Missing');
console.log('- API ID:', API_ID || '❌ Missing');
console.log('- API Hash:', API_HASH ? '✅ Set' : '❌ Missing');
console.log('- Supabase URL:', SUPABASE_URL ? '✅ Set' : '❌ Missing');
console.log('- Supabase Key:', SUPABASE_SERVICE_KEY ? '✅ Set' : '❌ Missing');

// Middleware to verify API secret
const verifySecret = (req, res, next) => {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    console.log('❌ Unauthorized request - Invalid API secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'telegram-transfer-service',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Telegram Transfer Service',
    status: 'running',
    endpoints: {
      health: 'GET /',
      checkOwnership: 'POST /api/check-ownership',
      transferOwnership: 'POST /api/transfer-ownership'
    },
    note: 'All POST endpoints require X-API-Secret header'
  });
});

// Check channel ownership endpoint
app.post('/api/check-ownership', verifySecret, async (req, res) => {
  const { channelUsername } = req.body;

  console.log('📡 Check ownership request:', { channelUsername });

  if (!channelUsername) {
    return res.status(400).json({ error: 'channelUsername is required' });
  }

  try {
    const result = await checkChannelOwnership(channelUsername);
    console.log('✅ Ownership check result:', result);
    res.json(result);
  } catch (error) {
    console.error('❌ Error checking ownership:', error);
    res.status(500).json({ 
      error: error.message,
      isOwner: false,
      currentRole: `error: ${error.message}`,
    });
  }
});

// Transfer ownership endpoint
app.post('/api/transfer-ownership', verifySecret, async (req, res) => {
  const { jobId, channelUsername, buyerUsername } = req.body;

  console.log('🔄 Transfer ownership request:', { jobId, channelUsername, buyerUsername });

  if (!jobId || !channelUsername || !buyerUsername) {
    return res.status(400).json({ 
      error: 'jobId, channelUsername, and buyerUsername are required' 
    });
  }

  try {
    console.log(`📋 Processing transfer for job ${jobId}`);
    console.log(`📢 Channel: ${channelUsername}, Buyer: ${buyerUsername}`);

    // Check ownership first
    const ownershipCheck = await checkChannelOwnership(channelUsername);
    
    if (!ownershipCheck.isOwner) {
      console.log('⚠️ Admin is not the owner yet');
      return res.status(400).json({
        error: 'Transfer not ready',
        details: ownershipCheck,
        instruction: 'Seller must first transfer channel ownership to admin account',
      });
    }

    console.log('✅ Admin ownership verified');

    // Transfer ownership
    await transferChannelOwnership(channelUsername, buyerUsername);

    console.log('✅ Ownership transferred successfully');

    // Update job status in Supabase
    const { error: updateError } = await supabase
      .from('jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (updateError) {
      console.error('❌ Failed to update job status:', updateError);
    } else {
      console.log('✅ Job status updated to completed');
    }

    // Update listing status
    const { data: job } = await supabase
      .from('jobs')
      .select('listing_id')
      .eq('id', jobId)
      .single();

    if (job) {
      await supabase
        .from('social_media_listings')
        .update({ status: 'sold' })
        .eq('id', job.listing_id);
      console.log('✅ Listing marked as sold');
    }

    res.json({
      success: true,
      message: 'Ownership transferred successfully',
      jobId,
    });
  } catch (error) {
    console.error('❌ Transfer error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack,
    });
  }
});

// Check channel ownership function
async function checkChannelOwnership(channelUsername) {
  let client = null;
  try {
    console.log('🔌 Creating Telegram client...');
    
    const session = new StringSession(ADMIN_SESSION_STRING.trim());
    client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
    });

    console.log('🔗 Connecting to Telegram...');
    await client.connect();
    console.log('✅ Connected to Telegram');

    const normalizedUsername = channelUsername.startsWith('@') 
      ? channelUsername.slice(1) 
      : channelUsername;

    console.log('📡 Fetching channel entity:', normalizedUsername);
    const channel = await client.getEntity(normalizedUsername);
    
    console.log('👤 Fetching current user info...');
    const me = await client.getMe();

    console.log('🔍 Getting participant info...');
    const participantInfo = await client.invoke(
      new Api.channels.GetParticipant({
        channel: channel,
        participant: me,
      })
    );

    const participant = participantInfo.participant;
    const isCreator = participant instanceof Api.ChannelParticipantCreator;
    const isAdmin = participant instanceof Api.ChannelParticipantAdmin;

    let currentRole = 'unknown';
    if (isCreator) currentRole = 'creator';
    else if (isAdmin) currentRole = 'admin';
    else currentRole = 'member';

    console.log('✅ Ownership check complete:', { isCreator, currentRole });

    return {
      isOwner: isCreator,
      currentRole,
      participantType: participant.constructor.name,
      channelId: channel.id?.toString(),
      channelTitle: channel.title,
    };
  } catch (error) {
    console.error('❌ Error in checkChannelOwnership:', error);
    throw error;
  } finally {
    if (client) {
      await client.disconnect();
      console.log('🔌 Disconnected from Telegram');
    }
  }
}

// Transfer channel ownership function
async function transferChannelOwnership(channelUsername, buyerUsername) {
  let client = null;
  try {
    console.log('🔌 Creating client for transfer...');
    
    const session = new StringSession(ADMIN_SESSION_STRING.trim());
    client = new TelegramClient(session, API_ID, API_HASH, {
      connectionRetries: 5,
    });

    console.log('🔗 Connecting for transfer...');
    await client.connect();

    const normalizedChannel = channelUsername.startsWith('@') 
      ? channelUsername.slice(1) 
      : channelUsername;
    const normalizedBuyer = buyerUsername.startsWith('@') 
      ? buyerUsername.slice(1) 
      : buyerUsername;

    console.log('📡 Getting channel entity...');
    const channel = await client.getEntity(normalizedChannel);
    
    console.log('👤 Getting buyer entity...');
    const buyerUser = await client.getEntity(normalizedBuyer);

    console.log('🔐 Getting 2FA password config...');
    const passwordSrp = await client.invoke(
      new Api.account.GetPassword()
    );
    
    console.log('🔑 Computing password hash...');
    const passwordHash = await computeCheck(passwordSrp, ADMIN_2FA_PASSWORD);

    console.log('🔄 Transferring ownership...');
    await client.invoke(
      new Api.channels.EditCreator({
        channel: channel,
        userId: buyerUser,
        password: passwordHash,
      })
    );

    console.log(`✅ Successfully transferred ${channelUsername} to ${buyerUsername}`);
  } catch (error) {
    console.error('❌ Error in transferChannelOwnership:', error);
    throw error;
  } finally {
    if (client) {
      await client.disconnect();
      console.log('🔌 Disconnected from Telegram');
    }
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Telegram Transfer Service running on port ${PORT}`);
  console.log(`🌍 Health check: http://localhost:${PORT}/health`);
});

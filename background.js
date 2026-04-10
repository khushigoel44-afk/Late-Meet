// Background Service Worker — AI Meeting Copilot
// Orchestrates audio capture, AI processing, and Supabase relay

import { chatCompletion, whisperTranscribe, getApiKey } from './utils/api.js';
import { SYSTEM_PROMPT, SUMMARY_PROMPT, LATE_JOINER_BRIEF_PROMPT } from './utils/prompts.js';

// ——— State ———
let meetingState = {
  isActive: false,
  meetingId: null,
  startTime: null,
  transcript: [],
  rawBuffer: '',
  summary: '',
  topics: [],
  decisions: [],
  actionItems: [],
  currentTopic: '',
  sentiment: 'neutral',
  keyInsights: [],
  questionsRaised: [],
  participants: [],
  initialParticipants: [],
  lateJoiners: [],
  timeline: [],
  audioActive: false
};

let processingInterval = null;
let offscreenCreated = false;

// ——— Offscreen Document ———
async function ensureOffscreen() {
  if (offscreenCreated) return;
  
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture meeting audio for transcription'
      });
    }
    offscreenCreated = true;
  } catch (err) {
    console.error('[BG] Failed to create offscreen document:', err);
  }
}

// ——— Audio Capture ———
async function startAudioCapture(tabId) {
  await ensureOffscreen();
  
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    
    chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId: streamId,
      tabId: tabId
    });
    
    console.log('[BG] Audio capture started for tab:', tabId);
  } catch (err) {
    console.error('[BG] Failed to start audio capture:', err);
  }
}

function stopAudioCapture() {
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  offscreenCreated = false;
  console.log('[BG] Audio capture stopped');
}

// ——— AI Processing ———
async function processTranscript() {
  if (!meetingState.isActive || meetingState.rawBuffer.trim().length < 20) return;
  
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('[BG] No API key — using demo mode');
    broadcastState();
    return;
  }
  
  const transcript = meetingState.rawBuffer;
  
  try {
    const prompt = SUMMARY_PROMPT(transcript, meetingState.summary);
    const result = await chatCompletion(SYSTEM_PROMPT, prompt, apiKey);
    
    if (result) {
      meetingState.summary = result.summary || meetingState.summary;
      meetingState.topics = result.topics || meetingState.topics;
      meetingState.decisions = result.decisions || meetingState.decisions;
      meetingState.actionItems = result.actionItems || meetingState.actionItems;
      meetingState.currentTopic = result.currentTopic || meetingState.currentTopic;
      meetingState.sentiment = result.sentiment || meetingState.sentiment;
      meetingState.keyInsights = result.keyInsights || meetingState.keyInsights;
      meetingState.questionsRaised = result.questionsRaised || meetingState.questionsRaised;
      
      // Save to storage
      await chrome.storage.local.set({ meetingState: getStateSnapshot() });
      
      // Push state to Supabase for late joiners
      pushStateToSupabase();
      
      // Broadcast to popup and dashboard
      broadcastState();
    }
  } catch (err) {
    console.error('[BG] AI processing failed:', err);
  }
}

// ——— Late Joiner Briefing ———
async function generateLateJoinerBrief(joinerName) {
  const apiKey = await getApiKey();
  if (!apiKey) return null;
  
  try {
    const prompt = LATE_JOINER_BRIEF_PROMPT(
      meetingState.summary,
      meetingState.topics,
      meetingState.decisions,
      meetingState.actionItems,
      meetingState.currentTopic,
      joinerName
    );
    
    const brief = await chatCompletion(SYSTEM_PROMPT, prompt, apiKey);
    
    if (brief && meetingState.meetingId) {
      // Push brief to Supabase for the late joiner's extension to pick up
      pushBriefToSupabase(meetingState.meetingId, brief, joinerName);
    }
    
    return brief;
  } catch (err) {
    console.error('[BG] Failed to generate late joiner brief:', err);
    return null;
  }
}

// ——— Supabase Integration ———
async function pushBriefToSupabase(meetingId, briefContent, targetParticipant) {
  const config = await chrome.storage.local.get(['supabase_url', 'supabase_anon_key']);
  if (!config.supabase_url || !config.supabase_anon_key) return;
  
  try {
    const response = await fetch(`${config.supabase_url}/rest/v1/meeting_briefs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabase_anon_key,
        'Authorization': `Bearer ${config.supabase_anon_key}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        meeting_id: meetingId,
        brief_content: briefContent,
        target_participant: targetParticipant
      })
    });
    
    if (response.ok) {
      console.log('[BG] Brief pushed to Supabase for:', targetParticipant);
    }
  } catch (err) {
    console.error('[BG] Supabase push failed:', err);
  }
}

async function pushStateToSupabase() {
  const config = await chrome.storage.local.get(['supabase_url', 'supabase_anon_key']);
  if (!config.supabase_url || !config.supabase_anon_key || !meetingState.meetingId) return;
  
  try {
    await fetch(`${config.supabase_url}/rest/v1/meeting_state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabase_anon_key,
        'Authorization': `Bearer ${config.supabase_anon_key}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        meeting_id: meetingState.meetingId,
        summary: meetingState.summary,
        topics: meetingState.topics,
        decisions: meetingState.decisions,
        action_items: meetingState.actionItems,
        current_topic: meetingState.currentTopic,
        participants: meetingState.participants,
        updated_at: new Date().toISOString()
      })
    });
  } catch (err) {
    console.error('[BG] Supabase state push failed:', err);
  }
}

// ——— State Management ———
function getStateSnapshot() {
  return {
    isActive: meetingState.isActive,
    meetingId: meetingState.meetingId,
    startTime: meetingState.startTime,
    duration: meetingState.startTime ? Math.round((Date.now() - meetingState.startTime) / 1000) : 0,
    summary: meetingState.summary,
    topics: meetingState.topics,
    decisions: meetingState.decisions,
    actionItems: meetingState.actionItems,
    currentTopic: meetingState.currentTopic,
    sentiment: meetingState.sentiment,
    keyInsights: meetingState.keyInsights,
    questionsRaised: meetingState.questionsRaised,
    participants: meetingState.participants,
    lateJoiners: meetingState.lateJoiners,
    timeline: meetingState.timeline,
    transcriptCount: meetingState.transcript.length,
    audioActive: meetingState.audioActive || false
  };
}

function broadcastState() {
  const snapshot = getStateSnapshot();
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: snapshot }).catch(() => {});
}

function resetState() {
  meetingState = {
    isActive: false, meetingId: null, startTime: null,
    transcript: [], rawBuffer: '', summary: '',
    topics: [], decisions: [], actionItems: [],
    currentTopic: '', sentiment: 'neutral', keyInsights: [],
    questionsRaised: [], participants: [], initialParticipants: [],
    lateJoiners: [], timeline: [], audioActive: false
  };
}

// ——— Message Handler ———
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'MEETING_STARTED': {
      resetState();
      meetingState.isActive = true;
      meetingState.meetingId = message.meetingId;
      meetingState.startTime = Date.now();
      meetingState.timeline.push({ event: 'Meeting started', timestamp: Date.now(), elapsed: 0 });
      meetingState.audioActive = false;
      
      // Periodic AI processing will only start when audio starts (or we can start it now)
      // processingInterval = setInterval(processTranscript, 30000);
      
      broadcastState();
      sendResponse({ success: true });
      break;
    }

    case 'START_AUDIO': {
      if (meetingState.isActive) {
        chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
          if (tabs.length > 0) {
            startAudioCapture(tabs[0].id);
            meetingState.audioActive = true;
            if (!processingInterval) {
              processingInterval = setInterval(processTranscript, 30000);
            }
            broadcastState();
          }
        });
      }
      sendResponse({ success: true });
      break;
    }

    case 'START_AUDIO_WITH_STREAM': {
      // Popup already obtained the streamId (user-gesture context)
      // Auto-activate meeting if content script hasn't detected it yet
      if (!meetingState.isActive) {
        resetState();
        meetingState.isActive = true;
        meetingState.startTime = Date.now();
        meetingState.timeline.push({ event: 'Meeting started (via audio)', timestamp: Date.now(), elapsed: 0 });
      }

      (async () => {
        await ensureOffscreen();
        chrome.runtime.sendMessage({
          type: 'START_CAPTURE',
          streamId: message.streamId,
          tabId: message.tabId
        });
        meetingState.audioActive = true;
        if (!processingInterval) {
          processingInterval = setInterval(processTranscript, 30000);
        }
        broadcastState();
      })();

      sendResponse({ success: true });
      break;
    }
    
    case 'MEETING_ENDED': {
      meetingState.isActive = false;
      meetingState.timeline.push({ event: 'Meeting ended', timestamp: Date.now(), elapsed: meetingState.startTime ? Math.round((Date.now() - meetingState.startTime) / 1000) : 0 });
      
      stopAudioCapture();
      if (processingInterval) {
        clearInterval(processingInterval);
        processingInterval = null;
      }
      
      // Final AI processing
      processTranscript();
      
      // Save final state
      chrome.storage.local.set({ lastMeetingState: getStateSnapshot() });
      broadcastState();
      sendResponse({ success: true });
      break;
    }
    
    case 'TRANSCRIPT_CHUNK': {
      const { speaker, text, timestamp } = message;
      meetingState.transcript.push({ speaker, text, timestamp });
      meetingState.rawBuffer += `${speaker || 'Unknown'}: ${text}\n`;
      sendResponse({ success: true });
      break;
    }
    
    case 'AUDIO_TRANSCRIBED': {
      // Received from offscreen document after Whisper processing
      const { text, language } = message;
      if (text && text.trim()) {
        meetingState.transcript.push({ speaker: 'Audio', text, timestamp: Date.now() });
        meetingState.rawBuffer += `${text}\n`;
      }
      sendResponse({ success: true });
      break;
    }
    
    case 'PARTICIPANTS_UPDATED': {
      const currentList = message.participants || [];
      
      if (meetingState.initialParticipants.length === 0) {
        meetingState.initialParticipants = [...currentList];
        meetingState.participants = [...currentList];
      } else {
        const newJoiners = currentList.filter(
          p => !meetingState.participants.includes(p)
        );
        
        meetingState.participants = [...currentList];
        
        // Process late joiners
        for (const joiner of newJoiners) {
          meetingState.lateJoiners.push(joiner);
          meetingState.timeline.push({
            event: `${joiner} joined (late)`,
            timestamp: Date.now(),
            elapsed: Math.round((Date.now() - meetingState.startTime) / 1000)
          });
          
          // Generate and push brief to Supabase
          generateLateJoinerBrief(joiner);
        }
      }
      
      broadcastState();
      sendResponse({ success: true });
      break;
    }
    
    case 'GET_STATE': {
      sendResponse(getStateSnapshot());
      break;
    }
    
    case 'OPEN_SIDE_PANEL': {
      if (sender.tab?.id) {
        chrome.sidePanel.open({ tabId: sender.tab.id });
      }
      sendResponse({ success: true });
      break;
    }
  }
  
  return true; // Keep message channel open for async responses
});

// ——— Side Panel Behavior ———
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ——— Handle extension installation ———
chrome.runtime.onInstalled.addListener(() => {
  console.log('[MeetingCopilot] Extension installed');
  chrome.storage.local.set({
    settings: {
      summarizationInterval: 30,
      autoSendBrief: true,
      lateJoinerBriefing: true
    }
  });
});

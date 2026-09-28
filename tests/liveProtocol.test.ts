import { describe, it, expect } from 'vitest';
import {
  LIVE_INPUT_MIME,
  buildAudio,
  buildSetup,
  buildToolResponse,
  parseServerMessage,
} from '../src/renderer/liveProtocol';

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

describe('buildSetup', () => {
  const tool = { name: 'open_application', description: 'open', parameters: { type: 'object' } };

  it('asks for spoken replies in the chosen voice, with the model addressed the way the API expects', () => {
    const { setup } = JSON.parse(buildSetup({ model: 'gemini-3.1-flash-live-preview', voice: 'Aoede', systemInstruction: 'Be brief.', tools: [tool] }));
    expect(setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Aoede');
    expect(setup.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
  });

  it('declares the tools, and turns on transcripts of both sides', () => {
    const { setup } = JSON.parse(buildSetup({ model: 'm', voice: 'v', systemInstruction: 's', tools: [tool] }));
    expect(setup.tools).toEqual([{ functionDeclarations: [tool] }]);
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
  });

  it('omits the tools block entirely when there are none', () => {
    const { setup } = JSON.parse(buildSetup({ model: 'm', voice: 'v', systemInstruction: 's', tools: [] }));
    expect(setup).not.toHaveProperty('tools');
  });
});

describe('client messages', () => {
  it('sends audio as base64 PCM tagged with its sample rate', () => {
    const msg = JSON.parse(buildAudio(new Uint8Array([1, 2, 3, 4])));
    expect(msg.realtimeInput.audio.mimeType).toBe(LIVE_INPUT_MIME);
    expect(LIVE_INPUT_MIME).toBe('audio/pcm;rate=16000');
    expect(msg.realtimeInput.audio.data).toBe(b64([1, 2, 3, 4]));
  });

  it('answers tool calls by id and name', () => {
    const msg = JSON.parse(buildToolResponse([{ id: 'c1', name: 'find_file', response: { ok: true } }]));
    expect(msg.toolResponse.functionResponses).toEqual([{ id: 'c1', name: 'find_file', response: { ok: true } }]);
  });
});

describe('parseServerMessage', () => {
  it('recognizes setup completing', () => {
    expect(parseServerMessage('{"setupComplete":{}}')).toEqual([{ type: 'setupComplete' }]);
  });

  it('reports what the user said and what the model said', () => {
    const events = parseServerMessage(JSON.stringify({
      serverContent: { inputTranscription: { text: 'Open Notepad.' }, outputTranscription: { text: "I've opened it" } },
    }));
    expect(events).toEqual([
      { type: 'heard', text: 'Open Notepad.' },
      { type: 'said', text: "I've opened it" },
    ]);
  });

  it('decodes spoken audio, and only audio', () => {
    const events = parseServerMessage(JSON.stringify({
      serverContent: {
        modelTurn: { parts: [
          { inlineData: { mimeType: 'audio/pcm;rate=24000', data: b64([9, 8, 7, 6]) } },
          { text: '**Planning my next step**' },
          { inlineData: { mimeType: 'image/png', data: b64([1]) } },
        ] },
      },
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'audio' });
    expect([...((events[0] as { pcm: Uint8Array }).pcm)]).toEqual([9, 8, 7, 6]);
  });

  it('reports tool calls with their ids and arguments', () => {
    const events = parseServerMessage(JSON.stringify({
      toolCall: { functionCalls: [{ id: 'call_1', name: 'open_application', args: { name: 'notepad' } }, { id: 'call_2', name: 'find_file' }] },
    }));
    expect(events).toEqual([{
      type: 'toolCall',
      calls: [
        { id: 'call_1', name: 'open_application', args: { name: 'notepad' } },
        { id: 'call_2', name: 'find_file', args: {} },
      ],
    }]);
  });

  it('drops malformed tool calls rather than passing them on', () => {
    const events = parseServerMessage(JSON.stringify({ toolCall: { functionCalls: [{ name: 'no_id' }, { id: 'x' }] } }));
    expect(events).toEqual([{ type: 'toolCall', calls: [] }]);
  });

  it('reports tool cancellations, interruptions and finished turns', () => {
    expect(parseServerMessage('{"toolCallCancellation":{"ids":["a","b"]}}')).toEqual([{ type: 'toolCancel', ids: ['a', 'b'] }]);
    expect(parseServerMessage('{"serverContent":{"interrupted":true}}')).toEqual([{ type: 'interrupted' }]);
    expect(parseServerMessage('{"serverContent":{"turnComplete":true}}')).toEqual([{ type: 'turnComplete' }]);
  });

  it('puts events in the order they happened: heard, interrupted, audio, said, turn end', () => {
    const events = parseServerMessage(JSON.stringify({
      serverContent: {
        turnComplete: true,
        outputTranscription: { text: 'hi' },
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: b64([1, 2]) } }] },
        interrupted: true,
        inputTranscription: { text: 'wait' },
      },
    }));
    expect(events.map((e) => e.type)).toEqual(['heard', 'interrupted', 'audio', 'said', 'turnComplete']);
  });

  it('tracks when the server hears speech start and stop', () => {
    expect(parseServerMessage('{"voiceActivity":{"type":"ACTIVITY_START","audioOffset":"0.2s"}}')).toEqual([{ type: 'voiceActivity', active: true }]);
    expect(parseServerMessage('{"voiceActivity":{"type":"ACTIVITY_END"}}')).toEqual([{ type: 'voiceActivity', active: false }]);
  });

  it('understands the warning that the session is about to be closed', () => {
    expect(parseServerMessage('{"goAway":{"timeLeft":"30s"}}')).toEqual([{ type: 'goAway', timeLeftMs: 30_000 }]);
  });

  it('ignores what it does not need: usage, resumption handles, empty messages, junk', () => {
    expect(parseServerMessage('{}')).toEqual([]);
    expect(parseServerMessage('{"usageMetadata":{"totalTokenCount":9}}')).toEqual([]);
    expect(parseServerMessage('{"sessionResumptionUpdate":{"newHandle":"h","resumable":true}}')).toEqual([]);
    expect(parseServerMessage('not json')).toEqual([]);
    expect(parseServerMessage('')).toEqual([]);
  });

  it('parses the messages the real service actually sent during my test', () => {
    const real = [
      '{"setupComplete":{}}',
      '{"voiceActivity":{"type":"ACTIVITY_START","audioOffset":"0.240s"}}',
      '{"serverContent":{"inputTranscription":{"text":"Open Notepad."}}}',
      '{"toolCall":{"functionCalls":[{"name":"open_application","args":{"name":"notepad"},"id":"call_2610826"}]}}',
    ];
    const all = real.flatMap(parseServerMessage);
    expect(all.map((e) => e.type)).toEqual(['setupComplete', 'voiceActivity', 'heard', 'toolCall']);
  });
});

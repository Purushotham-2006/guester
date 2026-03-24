/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Webcam from 'react-webcam';
import { Hands, Results, HAND_CONNECTIONS } from '@mediapipe/hands';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Volume2, VolumeX, Trophy, Settings, AlertCircle, RefreshCw } from 'lucide-react';

// --- Constants & Types ---

type GameState = 'START' | 'DIFFICULTY' | 'PLAYING' | 'GAMEOVER';
type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';

const DIFFICULTY_SETTINGS = {
  EASY: { speed: 10, obstacleFrequency: 0.01, gravity: 2.0, jumpStrength: -24 },
  MEDIUM: { speed: 15, obstacleFrequency: 0.02, gravity: 2.8, jumpStrength: -32 },
  HARD: { speed: 22, obstacleFrequency: 0.03, gravity: 3.8, jumpStrength: -42 },
};

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 400;
const GROUND_Y = 350;
const PLAYER_X = 100;
const PLAYER_SIZE = 50;
const MIN_OBSTACLE_GAP = 60; // Minimum frames between obstacles

// --- Sound Manager ---

class SoundManager {
  private audioContext: AudioContext | null = null;
  private enabled: boolean = true;

  constructor() {
    if (typeof window !== 'undefined') {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  private playTone(freq: number, type: OscillatorType, duration: number, volume: number = 0.1) {
    if (!this.enabled || !this.audioContext) return;
    
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    
    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.audioContext.currentTime);
    
    gain.gain.setValueAtTime(volume, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
    
    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    
    osc.start();
    osc.stop(this.audioContext.currentTime + duration);
  }

  playJump() { this.playTone(400, 'square', 0.2); }
  playClick() { this.playTone(600, 'sine', 0.1); }
  playGameOver() { this.playTone(150, 'sawtooth', 0.5, 0.2); }
  playRun() { /* Subtle running sound could be added here */ }
}

const soundManager = new SoundManager();

// --- Game Components ---

export default function App() {
  const [gameState, setGameState] = useState<GameState>('START');
  const [difficulty, setDifficulty] = useState<Difficulty>('EASY');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [handVisible, setHandVisible] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const handVisibleCounter = useRef(0);
  const VISIBILITY_THRESHOLD = 10; // Frames to wait before hiding hand indicator
  const [gesture, setGesture] = useState<'OPEN' | 'FIST' | 'NONE'>('NONE');
  const gestureRef = useRef<'OPEN' | 'FIST' | 'NONE'>('NONE');
  const handVisibleRef = useRef(false);
  const lastPermissionState = useRef<PermissionState | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const webcamRef = useRef<Webcam>(null);
  const handsRef = useRef<Hands | null>(null);
  const requestRef = useRef<number>(null);

  // Game Logic Refs
  const playerY = useRef(GROUND_Y - PLAYER_SIZE);
  const playerVelocity = useRef(0);
  const isJumping = useRef(false);
  const obstacles = useRef<{ x: number, width: number, height: number }[]>([]);
  const birds = useRef<{ x: number, y: number, speed: number, size: number }[]>([]);
  const clouds = useRef<{ x: number, y: number, speed: number, size: number }[]>([]);
  const frameCount = useRef(0);
  const lastObstacleFrame = useRef(0);
  const scoreRef = useRef(0);
  const highScoreRef = useRef(0);

  // Initialize background elements
  useEffect(() => {
    birds.current = Array.from({ length: 5 }, () => ({
      x: Math.random() * CANVAS_WIDTH,
      y: 50 + Math.random() * 100,
      speed: 1 + Math.random() * 2,
      size: 10 + Math.random() * 10
    }));
    clouds.current = Array.from({ length: 4 }, () => ({
      x: Math.random() * CANVAS_WIDTH,
      y: 30 + Math.random() * 80,
      speed: 0.5 + Math.random() * 1,
      size: 40 + Math.random() * 40
    }));
  }, []);

  // --- Hand Detection & Game Loop Setup ---

  useEffect(() => {
    // Proactively check camera permission status
    const checkPermission = async () => {
      if (!navigator.permissions || !navigator.permissions.query) return;

      try {
        const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
        
        const updatePermissionState = () => {
          const newState = status.state;
          const oldState = lastPermissionState.current;
          lastPermissionState.current = newState;

          if (newState === 'denied') {
            setCameraError(prev => prev !== 'Permission denied' ? 'Permission denied' : prev);
          } else if (newState === 'granted' && oldState === 'denied') {
            // Only auto-reset if we transitioned from denied to granted
            setCameraError(null);
            setCameraReady(false);
            setCameraKey(k => k + 1);
          }
        };

        updatePermissionState();
        status.onchange = updatePermissionState;
      } catch (err) {
        console.warn("Permission query failed:", err);
      }
    };

    const onFocus = () => checkPermission();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkPermission();
    };

    checkPermission();

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let hands: Hands | null = null;

    const initHands = async () => {
      console.log("Initializing MediaPipe Hands...");
      try {
        hands = new Hands({
          locateFile: (file) => {
            const url = `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
            console.log(`Loading MediaPipe file: ${file} from ${url}`);
            return url;
          },
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        hands.onResults((results: Results) => {
          if (!active) return;
          if (isModelLoading) {
            console.log("MediaPipe Hands model loaded and first results received.");
            setIsModelLoading(false);
          }

          // Draw landmarks on debug canvas
          const canvasElement = debugCanvasRef.current;
          if (canvasElement) {
            const canvasCtx = canvasElement.getContext('2d');
            if (canvasCtx) {
              canvasCtx.save();
              canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
              if (results.multiHandLandmarks) {
                for (const landmarks of results.multiHandLandmarks) {
                  drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 2 });
                  drawLandmarks(canvasCtx, landmarks, { color: '#FF0000', lineWidth: 1, radius: 2 });
                }
              }
              canvasCtx.restore();
            }
          }

          if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            handVisibleCounter.current = 0;
            if (!handVisibleRef.current) {
              setHandVisible(true);
              handVisibleRef.current = true;
            }
            const landmarks = results.multiHandLandmarks[0];
            
            const isFist = [8, 12, 16, 20].every(index => {
              const tip = landmarks[index];
              const knuckle = landmarks[index - 2];
              return tip.y > (knuckle.y + 0.02);
            });
            const newGesture = isFist ? 'FIST' : 'OPEN';
            if (gestureRef.current !== newGesture) {
              setGesture(newGesture);
              gestureRef.current = newGesture;
            }
          } else {
            handVisibleCounter.current++;
            if (handVisibleCounter.current > VISIBILITY_THRESHOLD) {
              if (handVisibleRef.current) {
                setHandVisible(false);
                handVisibleRef.current = false;
              }
              if (gestureRef.current !== 'NONE') {
                setGesture('NONE');
                gestureRef.current = 'NONE';
              }
            }
          }
        });

        handsRef.current = hands;
        console.log("MediaPipe Hands instance created.");
      } catch (err) {
        console.error("CRITICAL: Failed to initialize Hands:", err);
        setIsModelLoading(false);
      }
    };

    const offscreenCanvas = document.createElement('canvas');
    const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

    let isProcessing = false;
    const process = async () => {
      if (isProcessing) {
        if (active) requestAnimationFrame(process);
        return;
      }

      const video = webcamRef.current?.video;
      if (video && video.readyState >= 2 && video.videoWidth > 0 && handsRef.current && active && offscreenCtx) {
        isProcessing = true;
        try {
          offscreenCanvas.width = video.videoWidth;
          offscreenCanvas.height = video.videoHeight;
          
          // Draw directly to offscreen canvas for processing
          offscreenCtx.drawImage(video, 0, 0);
          
          await handsRef.current.send({ image: offscreenCanvas });
        } catch (err) {
          console.error("MediaPipe processing error:", err);
        } finally {
          isProcessing = false;
        }
      }
      if (active) requestAnimationFrame(process);
    };

    initHands().then(() => {
      if (active) {
        console.log("Starting processing loop...");
        process();
      }
    });

    return () => {
      active = false;
      if (hands) {
        hands.close();
      }
      handsRef.current = null;
    };
  }, []);

  // --- Game Loop ---

  const resetGame = useCallback((diff: Difficulty) => {
    setDifficulty(diff);
    setGameState('PLAYING');
    setScore(0);
    scoreRef.current = 0;
    playerY.current = GROUND_Y - PLAYER_SIZE;
    playerVelocity.current = 0;
    isJumping.current = false;
    obstacles.current = [];
    frameCount.current = 0;
    lastObstacleFrame.current = 0;
    soundManager.playClick();
  }, []);

  const updateGame = useCallback(() => {
    if (gameState !== 'PLAYING') return;

    const settings = DIFFICULTY_SETTINGS[difficulty];
    frameCount.current++;

    // Update Score (Internal Ref)
    scoreRef.current++;
    
    // Sync to React state less frequently to avoid lag
    if (frameCount.current % 5 === 0) {
      setScore(scoreRef.current);
      if (scoreRef.current > highScoreRef.current) {
        highScoreRef.current = scoreRef.current;
        setHighScore(scoreRef.current);
      }
    }

    // Handle Physics
    if (gestureRef.current === 'FIST' && !isJumping.current && handVisibleRef.current) {
      playerVelocity.current = settings.jumpStrength;
      isJumping.current = true;
      soundManager.playJump();
    }

    playerVelocity.current += settings.gravity;
    playerY.current += playerVelocity.current;

    if (playerY.current > GROUND_Y - PLAYER_SIZE) {
      playerY.current = GROUND_Y - PLAYER_SIZE;
      playerVelocity.current = 0;
      isJumping.current = false;
    }

    // Update Obstacles
    const dynamicMinGap = Math.max(35, MIN_OBSTACLE_GAP - Math.floor(frameCount.current / 400));
    const timeSinceLastObstacle = frameCount.current - lastObstacleFrame.current;
    
    if (timeSinceLastObstacle > dynamicMinGap && Math.random() < settings.obstacleFrequency + (frameCount.current / 8000)) {
      obstacles.current.push({
        x: CANVAS_WIDTH,
        width: 30 + Math.random() * 20,
        height: 40 + Math.random() * 40
      });
      lastObstacleFrame.current = frameCount.current;
    }

    obstacles.current = obstacles.current.filter(obs => {
      obs.x -= settings.speed + (frameCount.current / 1000);
      
      // Collision Detection
      if (
        PLAYER_X < obs.x + obs.width &&
        PLAYER_X + PLAYER_SIZE > obs.x &&
        playerY.current < GROUND_Y &&
        playerY.current + PLAYER_SIZE > GROUND_Y - obs.height
      ) {
        setGameState('GAMEOVER');
        soundManager.playGameOver();
        return false;
      }
      
      return obs.x + obs.width > 0;
    });

    // Draw
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) {
      // 1. Draw Sky Background
      const skyGradient = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
      skyGradient.addColorStop(0, '#87CEEB'); // Sky Blue
      skyGradient.addColorStop(1, '#E0F6FF'); // Light Blue
      ctx.fillStyle = skyGradient;
      ctx.fillRect(0, 0, CANVAS_WIDTH, GROUND_Y);

      // 2. Draw Sun
      ctx.fillStyle = '#FFD700';
      ctx.shadowBlur = 20;
      ctx.shadowColor = '#FFD700';
      ctx.beginPath();
      ctx.arc(CANVAS_WIDTH - 100, 80, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 3. Draw Clouds
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      clouds.current.forEach(cloud => {
        cloud.x -= cloud.speed;
        if (cloud.x + cloud.size < 0) cloud.x = CANVAS_WIDTH + cloud.size;
        
        ctx.beginPath();
        ctx.arc(cloud.x, cloud.y, cloud.size * 0.5, 0, Math.PI * 2);
        ctx.arc(cloud.x + cloud.size * 0.3, cloud.y - cloud.size * 0.2, cloud.size * 0.4, 0, Math.PI * 2);
        ctx.arc(cloud.x + cloud.size * 0.6, cloud.y, cloud.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // 4. Draw Birds
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 2;
      birds.current.forEach(bird => {
        bird.x -= bird.speed;
        if (bird.x + bird.size < 0) bird.x = CANVAS_WIDTH + bird.size;
        
        const wingPos = Math.sin(frameCount.current * 0.2) * 5;
        ctx.beginPath();
        ctx.moveTo(bird.x, bird.y);
        ctx.quadraticCurveTo(bird.x + bird.size / 2, bird.y - bird.size / 2 + wingPos, bird.x + bird.size, bird.y);
        ctx.moveTo(bird.x, bird.y);
        ctx.quadraticCurveTo(bird.x + bird.size / 2, bird.y + bird.size / 2 - wingPos, bird.x + bird.size, bird.y);
        ctx.stroke();
      });

      // 5. Draw Background Greenery (Distant Hills/Trees)
      ctx.fillStyle = '#2d5a27';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(i * 300 + 100, GROUND_Y, 150, Math.PI, 0);
        ctx.fill();
      }

      // 6. Draw Ground (Grass)
      const grassGradient = ctx.createLinearGradient(0, GROUND_Y, 0, CANVAS_HEIGHT);
      grassGradient.addColorStop(0, '#7cfc00'); // Lawn Green
      grassGradient.addColorStop(1, '#228b22'); // Forest Green
      ctx.fillStyle = grassGradient;
      ctx.fillRect(0, GROUND_Y, CANVAS_WIDTH, CANVAS_HEIGHT - GROUND_Y);

      // Draw Grass Blades (Randomly)
      ctx.strokeStyle = '#228b22';
      ctx.lineWidth = 1;
      for (let i = 0; i < CANVAS_WIDTH; i += 20) {
        const h = 5 + Math.sin(i + frameCount.current * 0.05) * 3;
        ctx.beginPath();
        ctx.moveTo(i, GROUND_Y);
        ctx.lineTo(i - 2, GROUND_Y - h);
        ctx.stroke();
      }

      // 7. Draw Player (Detailed Human Figure)
      const pX = PLAYER_X + PLAYER_SIZE / 2;
      const pY = playerY.current;
      const gestureColor = handVisibleRef.current ? (gestureRef.current === 'FIST' ? '#ef4444' : '#3b82f6') : '#94a3b8';
      const skinColor = '#ffdbac'; // Light skin tone
      const hairColor = '#4b2c20'; // Dark brown hair
      const pantsColor = '#2c3e50'; // Dark blue/gray pants
      
      ctx.lineCap = 'round';

      // Animation calculations
      const isPlayerJumping = isJumping.current;
      const runCycle = isPlayerJumping ? 0 : frameCount.current * (settings.speed * 0.025);
      const legSwing = isPlayerJumping ? 10 : Math.sin(runCycle) * 15;
      const armSwing = isPlayerJumping ? -10 : Math.sin(runCycle) * 12;

      // --- Legs (Pants) ---
      ctx.strokeStyle = pantsColor;
      ctx.lineWidth = 8;
      // Left Leg
      ctx.beginPath();
      ctx.moveTo(pX, pY + 35);
      ctx.lineTo(pX - 8 - legSwing, pY + 50);
      ctx.stroke();
      // Right Leg
      ctx.beginPath();
      ctx.moveTo(pX, pY + 35);
      ctx.lineTo(pX + 8 + legSwing, pY + 50);
      ctx.stroke();

      // --- Torso (Shirt) ---
      ctx.fillStyle = gestureColor;
      ctx.beginPath();
      // Draw a slightly wider torso for the shirt
      ctx.roundRect(pX - 8, pY + 16, 16, 20, 4);
      ctx.fill();

      // --- Arms (Sleeves + Skin) ---
      ctx.lineWidth = 5;
      // Left Arm
      ctx.strokeStyle = gestureColor; // Sleeve
      ctx.beginPath();
      ctx.moveTo(pX, pY + 20);
      const lArmEndX = pX - 12 - armSwing;
      const lArmEndY = pY + 28 + armSwing;
      ctx.lineTo(lArmEndX, lArmEndY);
      ctx.stroke();
      // Hand
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(lArmEndX, lArmEndY, 3, 0, Math.PI * 2);
      ctx.fill();

      // Right Arm
      ctx.strokeStyle = gestureColor; // Sleeve
      ctx.beginPath();
      ctx.moveTo(pX, pY + 20);
      const rArmEndX = pX + 12 + armSwing;
      const rArmEndY = pY + 28 - armSwing;
      ctx.lineTo(rArmEndX, rArmEndY);
      ctx.stroke();
      // Hand
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(rArmEndX, rArmEndY, 3, 0, Math.PI * 2);
      ctx.fill();

      // --- Head & Face ---
      // Neck
      ctx.strokeStyle = skinColor;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(pX, pY + 14);
      ctx.lineTo(pX, pY + 18);
      ctx.stroke();

      // Face
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(pX, pY + 8, 8, 0, Math.PI * 2);
      ctx.fill();

      // Hair
      ctx.fillStyle = hairColor;
      ctx.beginPath();
      ctx.arc(pX, pY + 5, 8, Math.PI, 0); // Top hair
      ctx.fill();
      ctx.fillRect(pX - 8, pY + 5, 4, 6); // Side hair

      // Eyes
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.arc(pX + 3, pY + 7, 1.5, 0, Math.PI * 2); // Right eye
      ctx.arc(pX - 1, pY + 7, 1.5, 0, Math.PI * 2); // Left eye
      ctx.fill();

      // Mouth
      ctx.strokeStyle = '#a52a2a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (isPlayerJumping) {
        ctx.arc(pX + 2, pY + 12, 2, 0, Math.PI * 2); // O mouth for jumping
      } else {
        ctx.arc(pX + 2, pY + 11, 3, 0.2, Math.PI - 0.2); // Smile
      }
      ctx.stroke();

      // 8. Draw Obstacles (Make them look like rocks or stumps)
      ctx.fillStyle = '#5d4037';
      obstacles.current.forEach(obs => {
        ctx.beginPath();
        ctx.roundRect(obs.x, GROUND_Y - obs.height, obs.width, obs.height, 5);
        ctx.fill();
        // Add some texture to obstacles
        ctx.strokeStyle = '#3e2723';
        ctx.lineWidth = 2;
        ctx.stroke();
      });
    }
  }, [gameState, difficulty]);

  useEffect(() => {
    let requestHandle: number;
    
    const loop = () => {
      if (gameState === 'PLAYING') {
        updateGame();
        requestHandle = requestAnimationFrame(loop);
      }
    };

    if (gameState === 'PLAYING') {
      requestHandle = requestAnimationFrame(loop);
    }

    return () => {
      if (requestHandle) cancelAnimationFrame(requestHandle);
    };
  }, [gameState, updateGame]);

  const toggleSound = () => {
    setSoundEnabled(!soundEnabled);
    soundManager.setEnabled(!soundEnabled);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans flex flex-col items-center justify-center p-4 overflow-hidden">
      
      {/* --- Game Header --- */}
      <div className="absolute top-6 left-6 right-6 flex justify-between items-center z-20">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tighter italic">GESTURE RUNNER</h1>
          <div className="bg-slate-900/80 backdrop-blur px-4 py-1 rounded-full border border-slate-800 flex items-center gap-2">
            <Trophy className="w-4 h-4 text-yellow-500" />
            <span className="text-sm font-mono">{highScore.toLocaleString()}</span>
          </div>
        </div>
        
        <button 
          onClick={toggleSound}
          className="p-3 rounded-full bg-slate-900/80 backdrop-blur border border-slate-800 hover:bg-slate-800 transition-colors"
        >
          {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
        </button>
      </div>

      {/* --- Main Game Area --- */}
      <div className="relative w-full max-w-4xl aspect-[2/1] bg-slate-900 rounded-2xl border-4 border-slate-800 shadow-2xl overflow-hidden">
        
        {/* Hand Status HUD */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-black/40 backdrop-blur-md px-6 py-2 rounded-full border border-white/10 z-30">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${handVisible ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500 shadow-[0_0_8px_#ef4444]'}`} />
            <span className="text-[10px] font-bold text-white uppercase tracking-widest">
              {handVisible ? 'Hand Detected' : 'No Hand'}
            </span>
          </div>
          <div className="w-px h-3 bg-white/20" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-white/60 uppercase tracking-widest">Action:</span>
            <span className={`text-[10px] font-bold uppercase tracking-widest ${gesture === 'FIST' ? 'text-amber-400' : 'text-emerald-400'}`}>
              {gesture === 'FIST' ? 'JUMP (FIST)' : gesture === 'OPEN' ? 'RUN (OPEN)' : 'WAITING'}
            </span>
          </div>
        </div>

        {/* Canvas for Game Rendering */}
        <canvas 
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          className="w-full h-full block"
        />

        {/* Camera Feed Overlay */}
        <div className="absolute bottom-4 right-4 w-64 aspect-video rounded-lg border-2 border-slate-700 overflow-hidden shadow-lg bg-black">
          <Webcam
            key={cameraKey}
            ref={webcamRef}
            mirrored
            audio={false}
            screenshotFormat="image/jpeg"
            disablePictureInPicture={true}
            forceScreenshotSourceSize={false}
            imageSmoothing={true}
            onUserMedia={() => {
              console.log("Webcam access granted.");
              setCameraReady(true);
              setCameraError(null);
            }}
            onUserMediaError={(err) => {
              console.error("Webcam access error:", err);
              const errorMessage = err.toString();
              setCameraError(prev => prev !== errorMessage ? errorMessage : prev);
            }}
            screenshotQuality={1}
            className="w-full h-full object-cover opacity-100"
            videoConstraints={{ width: 640, height: 480, facingMode: 'user' }}
          />
          <canvas 
            ref={debugCanvasRef}
            width={640}
            height={480}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none scale-x-[-1]"
          />
          
          {/* Loading / Error States */}
          {cameraError && (
            <div className="absolute inset-0 bg-red-950/95 flex flex-col items-center justify-center p-4 text-center gap-2 overflow-y-auto">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="w-6 h-6 text-red-500 shrink-0" />
                <div className="flex flex-col items-start">
                  <span className="text-[10px] text-red-200 font-bold uppercase tracking-widest leading-none">Camera Access Blocked</span>
                  <span className="text-[7px] text-red-500 font-bold uppercase mt-1 px-1 bg-red-500/10 border border-red-500/30 rounded">Status: Denied</span>
                </div>
              </div>
              
              <div className="bg-black/40 p-2 rounded border border-red-500/20 my-1 w-full max-w-[220px]">
                <span className="text-[8px] text-red-300 leading-tight block mb-2 font-medium">
                  {cameraError.includes('Permission denied') 
                    ? "Your browser is blocking camera access. This is required for gesture control."
                    : "Could not start camera. It might be in use by another app."}
                </span>
                
                <div className="text-[7px] text-slate-400 text-left space-y-2">
                  <div className="border-l-2 border-red-500/30 pl-2">
                    <p className="text-red-200 font-bold mb-0.5 uppercase">Chrome / Edge:</p>
                    <p>Click the <span className="text-red-400 font-bold">Camera/Lock icon</span> in the address bar & select <span className="text-emerald-400 font-bold">"Allow"</span>.</p>
                  </div>
                  <div className="border-l-2 border-blue-500/30 pl-2">
                    <p className="text-blue-200 font-bold mb-0.5 uppercase">Safari:</p>
                    <p>Go to <span className="text-white font-bold">Settings for this Website</span> & set Camera to <span className="text-emerald-400 font-bold">"Allow"</span>.</p>
                  </div>
                  <div className="border-l-2 border-orange-500/30 pl-2">
                    <p className="text-orange-200 font-bold mb-0.5 uppercase">Firefox:</p>
                    <p>Click the <span className="text-orange-400 font-bold">Camera icon</span> in the address bar & <span className="text-emerald-400 font-bold">Clear the Blocked status</span>.</p>
                  </div>
                </div>

                <div className="mt-3 pt-2 border-t border-white/5">
                  <p className="text-[6px] text-slate-500 uppercase font-bold mb-1">Privacy Note:</p>
                  <p className="text-[6px] text-slate-400 leading-tight">
                    Camera feed is processed <span className="text-white">locally</span> on your device. No video is ever sent to a server.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2 mt-1 w-full max-w-[220px]">
                <button 
                  onClick={async () => {
                    try {
                      // Try to trigger the native prompt
                      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                      // If successful, stop the stream immediately and reset camera
                      stream.getTracks().forEach(track => track.stop());
                      setCameraError(null);
                      setCameraReady(false);
                      setCameraKey(prev => prev + 1);
                    } catch (err) {
                      console.error("Manual permission request failed:", err);
                      setCameraError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  className="w-full px-3 py-2 bg-emerald-500 hover:bg-emerald-600 border border-emerald-400 rounded text-[9px] font-bold uppercase text-white transition-all shadow-lg shadow-emerald-900/40 active:scale-95"
                >
                  Try Requesting Again
                </button>
                <div className="flex gap-2">
                  <button 
                    onClick={() => {
                      setCameraError(null);
                      setCameraReady(false);
                      setCameraKey(prev => prev + 1);
                    }}
                    className="flex-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-[8px] font-bold uppercase text-slate-300 transition-colors"
                  >
                    Reset
                  </button>
                  <button 
                    onClick={() => window.location.reload()}
                    className="flex-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-[8px] font-bold uppercase text-slate-300 transition-colors"
                  >
                    Reload
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {!cameraReady && !cameraError && (
            <div className="absolute inset-0 bg-slate-900 flex flex-col items-center justify-center gap-2">
              <RefreshCw className="w-6 h-6 text-slate-500 animate-spin" />
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Starting Camera...</span>
            </div>
          )}

          {isModelLoading && cameraReady && (
            <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3">
              <RefreshCw className="w-6 h-6 text-emerald-500 animate-spin" />
              <div className="flex flex-col items-center text-center px-4">
                <span className="text-[10px] text-emerald-500 font-bold uppercase tracking-widest">AI Calibrating...</span>
                <span className="text-[8px] text-slate-300 mt-1">Show your hand clearly to the camera</span>
              </div>
              <button 
                onClick={() => window.location.reload()}
                className="mt-2 px-3 py-1 bg-emerald-500/20 hover:bg-emerald-500/40 border border-emerald-500/50 rounded text-[8px] font-bold uppercase text-emerald-400 transition-colors"
              >
                Retry Calibration
              </button>
            </div>
          )}

          <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded backdrop-blur-sm">
            <div className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-[7px] text-amber-500 font-bold uppercase tracking-tighter">Low Light Boost</span>
          </div>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {!handVisible && !isModelLoading && (
              <div className="bg-red-500/80 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 animate-pulse">
                <AlertCircle className="w-2 h-2" />
                HAND NOT VISIBLE
              </div>
            )}
          </div>
        </div>

        {/* Score Display */}
        {gameState === 'PLAYING' && (
          <div className="absolute top-4 right-4 text-4xl font-mono font-bold text-slate-400/30 select-none">
            {score.toLocaleString()}
          </div>
        )}

        {/* --- UI Screens --- */}
        <AnimatePresence mode="wait">
          {gameState === 'START' && (
            <motion.div 
              key="start"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center"
            >
              <h2 className="text-6xl font-black mb-2 tracking-tighter italic text-transparent bg-clip-text bg-gradient-to-br from-blue-400 to-emerald-400">
                READY TO RUN?
              </h2>
              <p className="text-slate-400 mb-8 max-w-md">
                Control the game with your hands. <br/>
                <span className="text-blue-400 font-bold">Open Hand (✋)</span> to run, <br/>
                <span className="text-red-400 font-bold">Fist (✊)</span> to jump over obstacles.
              </p>
              <button 
                onClick={() => { setGameState('DIFFICULTY'); soundManager.playClick(); }}
                className="group relative px-8 py-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-bold text-xl flex items-center gap-3 transition-all hover:scale-105 active:scale-95"
              >
                <Play className="w-6 h-6 fill-current" />
                START GAME
                <div className="absolute -inset-1 bg-blue-600 rounded-xl blur opacity-30 group-hover:opacity-60 transition-opacity" />
              </button>
            </motion.div>
          )}

          {gameState === 'DIFFICULTY' && (
            <motion.div 
              key="difficulty"
              initial={{ opacity: 0, scale: 1.1 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-8"
            >
              <h3 className="text-2xl font-bold mb-8 text-slate-400 uppercase tracking-widest">Select Difficulty</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl">
                {(['EASY', 'MEDIUM', 'HARD'] as Difficulty[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => resetGame(d)}
                    className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 hover:scale-105 active:scale-95 ${
                      d === 'EASY' ? 'border-emerald-500/30 hover:bg-emerald-500/10 text-emerald-400' :
                      d === 'MEDIUM' ? 'border-blue-500/30 hover:bg-blue-500/10 text-blue-400' :
                      'border-red-500/30 hover:bg-red-500/10 text-red-400'
                    }`}
                  >
                    <span className="text-2xl font-black italic">{d}</span>
                    <span className="text-xs opacity-60">
                      {d === 'EASY' ? 'Chill Pace' : d === 'MEDIUM' ? 'Steady Run' : 'Extreme Speed'}
                    </span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {gameState === 'GAMEOVER' && (
            <motion.div 
              key="gameover"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="absolute inset-0 bg-red-950/90 backdrop-blur-md flex flex-col items-center justify-center p-8 text-center"
            >
              <h2 className="text-7xl font-black mb-2 text-red-500 italic tracking-tighter">GAME OVER</h2>
              <div className="mb-8">
                <p className="text-slate-400 uppercase tracking-widest text-sm mb-1">Final Score</p>
                <p className="text-5xl font-mono font-bold">{score.toLocaleString()}</p>
              </div>
              <div className="flex gap-4">
                <button 
                  onClick={() => resetGame(difficulty)}
                  className="px-6 py-3 bg-white text-slate-950 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-200 transition-colors"
                >
                  <RefreshCw className="w-5 h-5" />
                  TRY AGAIN
                </button>
                <button 
                  onClick={() => { setGameState('START'); soundManager.playClick(); }}
                  className="px-6 py-3 bg-slate-800 text-white rounded-xl font-bold hover:bg-slate-700 transition-colors"
                >
                  MENU
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hand Status Warning during Play */}
        {gameState === 'PLAYING' && !handVisible && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/40 backdrop-blur-[2px] pointer-events-none">
            <div className="bg-red-500 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-3 shadow-2xl animate-bounce">
              <AlertCircle className="w-6 h-6" />
              HAND NOT VISIBLE!
            </div>
          </div>
        )}
      </div>

      {/* --- Footer / Instructions --- */}
      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl w-full text-slate-400 text-sm">
        <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800">
          <h4 className="text-slate-200 font-bold mb-3 flex items-center gap-2">
            <Settings className="w-4 h-4" />
            HOW TO PLAY
          </h4>
          <ul className="space-y-2 list-disc list-inside">
            <li>Position yourself so your hand is clearly visible to the camera.</li>
            <li>Keep your hand <span className="text-blue-400 font-semibold">OPEN (✋)</span> to keep running.</li>
            <li>Make a <span className="text-red-400 font-semibold">FIST (✊)</span> to jump over obstacles.</li>
            <li>The game gets faster the longer you survive!</li>
          </ul>
        </div>
        <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800">
          <h4 className="text-slate-200 font-bold mb-3 flex items-center gap-2">
            <Play className="w-4 h-4" />
            DIFFICULTY LEVELS
          </h4>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span>Easy</span>
              <div className="h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-emerald-500" />
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span>Medium</span>
              <div className="h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full w-2/3 bg-blue-500" />
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span>Hard</span>
              <div className="h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full w-full bg-red-500" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

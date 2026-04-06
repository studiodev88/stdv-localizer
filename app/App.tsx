import { StatusBar } from "expo-status-bar";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  SafeAreaView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Linking,
} from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { WebView } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";

// --- CONFIG ---
const WS_URL = "wss://localizer-backend.sebastian-drewniak.workers.dev/ws";
const API_URL = "https://localizer-backend.sebastian-drewniak.workers.dev/api/location";
const GITHUB_REPO = "studiodev88/stdv-localizer";
const CURRENT_VERSION = "1.2.2";
const BACKGROUND_LOCATION_TASK = "background-location-task";

const STORAGE_ROOM = "@localizer/room";
const STORAGE_USER = "@localizer/user";
const STORAGE_DEVICE_ID = "@localizer/deviceId";

// --- LIGHT THEME ---
const COLORS = {
  bg: "#F2F2F7",
  card: "#FFFFFF",
  accent: "#007AFF",
  highlight: "#FF3B30",
  green: "#34C759",
  text: "#1C1C1E",
  textMuted: "#8E8E93",
  input: "#E5E5EA",
  overlay: "rgba(255, 255, 255, 0.94)",
};

type PeerLocation = {
  lat: number;
  lng: number;
  name: string;
  timestamp: number;
};

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// --- PERSISTENT DEVICE ID ---
async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(STORAGE_DEVICE_ID);
  if (!id) {
    id = "dev-" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    await AsyncStorage.setItem(STORAGE_DEVICE_ID, id);
  }
  return id;
}

// --- BACKGROUND LOCATION TASK ---
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }: any) => {
  if (error) return;
  if (data?.locations?.length) {
    try {
      const room = await AsyncStorage.getItem(STORAGE_ROOM);
      const user = await AsyncStorage.getItem(STORAGE_USER);
      const deviceId = await AsyncStorage.getItem(STORAGE_DEVICE_ID);
      if (!room || !deviceId) return;

      const loc = data.locations[0];
      await fetch(`${API_URL}/${room}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          name: user || "Anonim",
          userId: deviceId,
        }),
      });
    } catch {}
  }
});

// --- MAP HTML ---
function getMapHtml(lat: number, lng: number): string {
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { margin: 0; padding: 0; }
  html, body, #map { width: 100%; height: 100%; }
</style>
</head><body>
<div id="map"></div>
<script>
  var map = L.map('map', {zoomControl: false}).setView([${lat}, ${lng}], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: ''
  }).addTo(map);

  var myIcon = L.divIcon({
    html: '<div style="width:20px;height:20px;background:#34C759;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>',
    iconSize: [20, 20], iconAnchor: [10, 10], className: ''
  });

  function makePeerIcon(color) {
    return L.divIcon({
      html: '<div style="width:20px;height:20px;background:'+color+';border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>',
      iconSize: [20, 20], iconAnchor: [10, 10], className: ''
    });
  }

  var peerColors = ['#FF3B30','#FF9500','#AF52DE','#5856D6','#FF2D55','#00C7BE','#FFD60A'];
  var peerColorMap = {};
  var colorIndex = 0;
  function getColor(uid) {
    if (!peerColorMap[uid]) {
      peerColorMap[uid] = peerColors[colorIndex % peerColors.length];
      colorIndex++;
    }
    return peerColorMap[uid];
  }

  var myMarker = L.marker([${lat}, ${lng}], {icon: myIcon}).addTo(map).bindPopup('Ja');
  var peerMarkers = {};

  function updateMyLocation(lat, lng, name) {
    myMarker.setLatLng([lat, lng]).setPopupContent(name || 'Ja');
  }

  function updatePeerLocation(uid, lat, lng, name) {
    if (!peerMarkers[uid]) {
      var icon = makePeerIcon(getColor(uid));
      peerMarkers[uid] = L.marker([lat, lng], {icon: icon}).addTo(map).bindPopup(name);
    } else {
      peerMarkers[uid].setLatLng([lat, lng]).setPopupContent(name);
    }
  }

  function removePeer(uid) {
    if (peerMarkers[uid]) {
      map.removeLayer(peerMarkers[uid]);
      delete peerMarkers[uid];
      delete peerColorMap[uid];
    }
  }

  function fitAll() {
    var pts = [[myMarker.getLatLng().lat, myMarker.getLatLng().lng]];
    for (var uid in peerMarkers) {
      var ll = peerMarkers[uid].getLatLng();
      pts.push([ll.lat, ll.lng]);
    }
    if (pts.length > 1) map.fitBounds(pts, {padding: [60, 60]});
  }

  function handleMsg(e) {
    try {
      var msg = JSON.parse(e.data || e);
      if (msg.type === 'myLocation') updateMyLocation(msg.lat, msg.lng, msg.name);
      else if (msg.type === 'peerLocation') updatePeerLocation(msg.uid, msg.lat, msg.lng, msg.name);
      else if (msg.type === 'removePeer') removePeer(msg.uid);
      else if (msg.type === 'fitAll') fitAll();
    } catch(err) {}
  }
  document.addEventListener('message', function(e) { handleMsg(e); });
  window.addEventListener('message', function(e) { handleMsg(e); });
</script>
</body></html>`;
}

// --- UPDATE CHECKER ---
async function checkForUpdate(): Promise<{
  hasUpdate: boolean;
  downloadUrl?: string;
  version?: string;
}> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
    );
    if (!res.ok) return { hasUpdate: false };
    const data = await res.json();
    const latestVersion = data.tag_name?.replace("v", "") || "";
    if (latestVersion && latestVersion !== CURRENT_VERSION) {
      const apkAsset = data.assets?.find((a: any) => a.name.endsWith(".apk"));
      return {
        hasUpdate: true,
        downloadUrl: apkAsset?.browser_download_url,
        version: latestVersion,
      };
    }
  } catch {}
  return { hasUpdate: false };
}

async function downloadAndInstallUpdate(url: string) {
  try {
    await Linking.openURL(url);
  } catch (e: any) {
    Alert.alert("Blad aktualizacji", e.message || "Nie udalo sie otworzyc linku.");
  }
}

// --- MAIN APP ---
export default function App() {
  const [screen, setScreen] = useState<"loading" | "home" | "map">("loading");
  const [roomCode, setRoomCode] = useState("");
  const [userName, setUserName] = useState("");
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [peers, setPeers] = useState<Record<string, PeerLocation>>({});
  const [peerCount, setPeerCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; url: string } | null>(null);
  const [updating, setUpdating] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const webViewRef = useRef<WebView | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Init: check stored session ---
  useEffect(() => {
    (async () => {
      checkForUpdate().then((r) => {
        if (r.hasUpdate && r.downloadUrl && r.version)
          setUpdateInfo({ version: r.version, url: r.downloadUrl });
      });

      const storedRoom = await AsyncStorage.getItem(STORAGE_ROOM);
      const storedUser = await AsyncStorage.getItem(STORAGE_USER);
      if (storedUser) setUserName(storedUser);
      if (storedRoom) {
        setRoomCode(storedRoom);
        connectToRoom(storedRoom, storedUser || "");
      } else {
        setScreen("home");
      }
    })();

    return () => {
      wsRef.current?.close();
      locationSubRef.current?.remove();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, []);

  // --- Send my location to WebView ---
  useEffect(() => {
    if (screen === "map" && myLocation && webViewRef.current) {
      webViewRef.current.postMessage(
        JSON.stringify({ type: "myLocation", lat: myLocation.lat, lng: myLocation.lng, name: userName || "Ja" })
      );
    }
  }, [myLocation, screen]);

  // --- Send peer locations to WebView ---
  useEffect(() => {
    if (screen === "map" && webViewRef.current) {
      Object.entries(peers).forEach(([uid, p]) => {
        webViewRef.current?.postMessage(
          JSON.stringify({ type: "peerLocation", uid, lat: p.lat, lng: p.lng, name: p.name })
        );
      });
    }
  }, [peers, screen]);

  // --- Connect ---
  const connectToRoom = useCallback(
    async (code: string, nameOverride?: string) => {
      try {
        setConnecting(true);
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          Alert.alert("Brak uprawnien", "Aplikacja wymaga dostepu do lokalizacji.");
          setConnecting(false);
          setScreen("home");
          return;
        }

        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setMyLocation(coords);

        const currentName = nameOverride !== undefined ? nameOverride : userName;
        const deviceId = await getDeviceId();
        const ws = new WebSocket(`${WS_URL}/${code.toUpperCase()}?userId=${encodeURIComponent(deviceId)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          setConnecting(false);
          setScreen("map");
          ws.send(JSON.stringify({ lat: coords.lat, lng: coords.lng, name: currentName || "Anonim" }));
          // Persist session
          AsyncStorage.setItem(STORAGE_ROOM, code.toUpperCase());
          AsyncStorage.setItem(STORAGE_USER, currentName);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "location") {
              setPeers((prev) => ({
                ...prev,
                [data.userId]: { lat: data.lat, lng: data.lng, name: data.name, timestamp: data.timestamp },
              }));
            } else if (data.type === "user_left") {
              setPeers((prev) => {
                const next = { ...prev };
                delete next[data.userId];
                return next;
              });
              webViewRef.current?.postMessage(JSON.stringify({ type: "removePeer", uid: data.userId }));
            } else if (data.type === "users") {
              setPeerCount(data.count);
            }
          } catch {}
        };

        ws.onclose = () => {
          setConnected(false);
          // Auto-reconnect if still in a room
          reconnectTimer.current = setTimeout(async () => {
            const room = await AsyncStorage.getItem(STORAGE_ROOM);
            if (room) connectToRoom(room);
          }, 3000);
        };

        ws.onerror = () => {
          setConnecting(false);
          setConnected(false);
        };

        // Foreground location watching
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 3, timeInterval: 2000 },
          (newLoc) => {
            const c = { lat: newLoc.coords.latitude, lng: newLoc.coords.longitude };
            setMyLocation(c);
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ lat: c.lat, lng: c.lng, name: currentName || "Anonim" }));
            }
          }
        );
        locationSubRef.current = sub;

        // Background location
        try {
          const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
          if (bgStatus === "granted") {
            const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
            if (!isRunning) {
              await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
                accuracy: Location.Accuracy.Balanced,
                timeInterval: 10000,
                distanceInterval: 15,
                foregroundService: {
                  notificationTitle: "Localizer",
                  notificationBody: "Udostepnianie lokalizacji...",
                  notificationColor: "#007AFF",
                },
                pausesUpdatesAutomatically: false,
              });
            }
          }
        } catch {}
      } catch (e: any) {
        setConnecting(false);
        setScreen("home");
        Alert.alert("Blad", e.message || "Cos poszlo nie tak.");
      }
    },
    [userName]
  );

  // --- Disconnect ---
  const disconnect = useCallback(async () => {
    wsRef.current?.close();
    wsRef.current = null;
    locationSubRef.current?.remove();
    locationSubRef.current = null;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);

    try {
      const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRunning) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    } catch {}

    await AsyncStorage.removeItem(STORAGE_ROOM);
    setPeers({});
    setPeerCount(0);
    setConnected(false);
    setScreen("home");
  }, []);

  // --- LOADING SCREEN ---
  if (screen === "loading") {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.loadingScreen}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={[styles.textMuted, { marginTop: 16 }]}>Laczenie...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // --- HOME SCREEN ---
  if (screen === "home") {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.homeContent}>
          <Text style={styles.title}>Localizer</Text>
          <Text style={styles.subtitle}>Udostepniaj lokalizacje w czasie rzeczywistym</Text>
          <Text style={styles.version}>v{CURRENT_VERSION}</Text>

          {updateInfo && (
            <TouchableOpacity
              style={styles.updateBanner}
              onPress={async () => {
                setUpdating(true);
                await downloadAndInstallUpdate(updateInfo.url);
                setUpdating(false);
              }}
              disabled={updating}
            >
              {updating ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.updateText}>
                  Nowa wersja {updateInfo.version} — kliknij aby zaktualizowac
                </Text>
              )}
            </TouchableOpacity>
          )}

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Twoje imie</Text>
            <TextInput
              style={styles.input}
              value={userName}
              onChangeText={(t) => {
                setUserName(t);
                AsyncStorage.setItem(STORAGE_USER, t);
              }}
              placeholder="np. Marek"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Kod pokoju</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={roomCode}
              onChangeText={(t) => setRoomCode(t.toUpperCase())}
              placeholder="np. ABC123"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="characters"
              maxLength={6}
            />
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              if (!roomCode.trim()) {
                Alert.alert("Wpisz kod", "Podaj kod pokoju aby dolaczyc.");
                return;
              }
              connectToRoom(roomCode.trim());
            }}
            disabled={connecting}
          >
            {connecting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Dolacz do pokoju</Text>
            )}
          </TouchableOpacity>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>lub</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={[styles.button, styles.buttonSecondary]}
            onPress={() => {
              const code = generateRoomCode();
              setRoomCode(code);
              connectToRoom(code);
            }}
            disabled={connecting}
          >
            {connecting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.buttonText, { color: COLORS.accent }]}>Utworz nowy pokoj</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // --- MAP SCREEN ---
  const peerList = Object.entries(peers);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.mapContainer}>
        {myLocation && (
          <WebView
            ref={webViewRef}
            originWhitelist={["*"]}
            source={{ html: getMapHtml(myLocation.lat, myLocation.lng) }}
            style={styles.map}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loadingMap}>
                <ActivityIndicator size="large" color={COLORS.accent} />
              </View>
            )}
          />
        )}

        {/* Top bar */}
        <View style={styles.topBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.roomCodeDisplay}>Pokoj: {roomCode}</Text>
            <Text style={styles.statusText}>
              {connected ? "Polaczono" : "Ponowne laczenie..."} · {peerCount}{" "}
              {peerCount === 1 ? "osoba" : peerCount < 5 ? "osoby" : "osob"}
            </Text>
          </View>
          <TouchableOpacity style={styles.exitButton} onPress={disconnect}>
            <Text style={styles.exitButtonText}>Wyjdz</Text>
          </TouchableOpacity>
        </View>

        {/* Bottom panel */}
        {peerList.length > 0 ? (
          <View style={styles.bottomPanel}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <Text style={styles.bottomTitle}>Uzytkownicy ({peerList.length})</Text>
              <TouchableOpacity
                style={styles.fitButton}
                onPress={() => webViewRef.current?.postMessage(JSON.stringify({ type: "fitAll" }))}
              >
                <Text style={styles.fitButtonText}>Pokaz wszystkich</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 120 }}>
              {peerList.map(([uid, p]) => (
                <View key={uid} style={styles.peerRow}>
                  <Text style={styles.peerName}>{p.name}</Text>
                  <Text style={styles.peerCoords}>
                    {p.lat.toFixed(4)}, {p.lng.toFixed(4)}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        ) : connected ? (
          <View style={styles.waitingBanner}>
            <Text style={styles.waitingText}>
              Czekam na innych uzytkownikow...{"\n"}Kod pokoju:{" "}
              <Text style={{ fontWeight: "800", fontSize: 22, color: COLORS.accent }}>{roomCode}</Text>
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

// --- STYLES ---
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  loadingScreen: { flex: 1, justifyContent: "center", alignItems: "center" },
  textMuted: { color: COLORS.textMuted, fontSize: 14 },
  homeContent: { flex: 1, justifyContent: "center", paddingHorizontal: 32 },
  title: { fontSize: 42, fontWeight: "800", color: COLORS.text, textAlign: "center", marginBottom: 4 },
  subtitle: { fontSize: 16, color: COLORS.textMuted, textAlign: "center", marginBottom: 4 },
  version: { fontSize: 12, color: COLORS.textMuted, textAlign: "center", marginBottom: 32 },
  updateBanner: {
    backgroundColor: "#34C759",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    marginBottom: 24,
  },
  updateText: { color: "#fff", fontSize: 14, fontWeight: "600", textAlign: "center" },
  inputGroup: { marginBottom: 20 },
  label: { color: COLORS.textMuted, fontSize: 13, marginBottom: 6, marginLeft: 4 },
  input: {
    backgroundColor: COLORS.input,
    color: COLORS.text,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
  },
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: "center", fontWeight: "700" },
  button: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  buttonSecondary: { backgroundColor: COLORS.card, borderWidth: 1.5, borderColor: COLORS.accent },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 24 },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLORS.input },
  dividerText: { color: COLORS.textMuted, marginHorizontal: 16, fontSize: 13 },
  mapContainer: { flex: 1 },
  map: { ...StyleSheet.absoluteFillObject },
  loadingMap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.bg,
    justifyContent: "center",
    alignItems: "center",
  },
  topBar: {
    position: "absolute",
    top: Platform.OS === "android" ? 40 : 10,
    left: 12,
    right: 12,
    backgroundColor: COLORS.overlay,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  roomCodeDisplay: { color: COLORS.text, fontSize: 18, fontWeight: "700" },
  statusText: { color: COLORS.textMuted, fontSize: 12, marginTop: 2 },
  exitButton: {
    backgroundColor: COLORS.highlight,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  exitButtonText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  bottomPanel: {
    position: "absolute",
    bottom: 30,
    left: 12,
    right: 12,
    backgroundColor: COLORS.overlay,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 4,
  },
  bottomTitle: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  fitButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  fitButtonText: { color: "#fff", fontWeight: "700", fontSize: 12 },
  peerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.input,
  },
  peerName: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  peerCoords: { color: COLORS.textMuted, fontSize: 12 },
  waitingBanner: {
    position: "absolute",
    bottom: 30,
    left: 12,
    right: 12,
    backgroundColor: COLORS.overlay,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 20,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  waitingText: { color: COLORS.text, fontSize: 16, textAlign: "center", lineHeight: 26 },
});

import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { createRoom, GatewayRequestError } from "../lib/gateway";
import { COLORS } from "../lib/theme";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = name.trim().length > 0 && videoUrl.trim().length > 0 && !creating;
  const canJoin = name.trim().length > 0 && joinCode.trim().length === 6;

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const { code } = await createRoom({ hostName: name.trim(), videoUrl: videoUrl.trim() });
      router.push({ pathname: "/room/[code]", params: { code, name: name.trim() } });
    } catch (err) {
      setError(err instanceof GatewayRequestError ? err.message : "Could not reach the gateway.");
    } finally {
      setCreating(false);
    }
  }

  function handleJoin() {
    router.push({ pathname: "/room/[code]", params: { code: joinCode.trim().toUpperCase(), name: name.trim() } });
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={styles.title}>SyncStream</Text>
      <Text style={styles.subtitle}>Watch YouTube together, perfectly in sync.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Sahil"
          placeholderTextColor={COLORS.textDim}
          maxLength={40}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Create a room</Text>
        <TextInput
          style={styles.input}
          value={videoUrl}
          onChangeText={setVideoUrl}
          placeholder="Paste a YouTube URL"
          placeholderTextColor={COLORS.textDim}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.button, !canCreate && styles.buttonDisabled]}
          disabled={!canCreate}
          onPress={handleCreate}
        >
          {creating ? <ActivityIndicator color={COLORS.bg} /> : <Text style={styles.buttonText}>Create room</Text>}
        </TouchableOpacity>
        {creating && (
          <Text style={styles.connectingHint}>
            Connecting to server... the first request can take up to a minute while it wakes up.
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Join a room</Text>
        <TextInput
          style={[styles.input, styles.codeInput]}
          value={joinCode}
          onChangeText={(v) => setJoinCode(v.toUpperCase())}
          placeholder="6-CHAR CODE"
          placeholderTextColor={COLORS.textDim}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
        />
        <TouchableOpacity
          style={[styles.button, !canJoin && styles.buttonDisabled]}
          disabled={!canJoin}
          onPress={handleJoin}
        >
          <Text style={styles.buttonText}>Join room</Text>
        </TouchableOpacity>
      </View>

      {error && (
        <View>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity onPress={handleCreate} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 24,
    paddingTop: 96,
  },
  title: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: "700",
  },
  subtitle: {
    color: COLORS.textDim,
    fontSize: 14,
    marginTop: 4,
    marginBottom: 32,
  },
  field: {
    marginBottom: 24,
  },
  label: {
    color: COLORS.textDim,
    fontSize: 13,
    marginBottom: 6,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    marginBottom: 20,
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 12,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 12,
  },
  codeInput: {
    letterSpacing: 4,
    textAlign: "center",
    fontSize: 20,
    fontWeight: "700",
  },
  button: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: COLORS.bg,
    fontWeight: "700",
    fontSize: 15,
  },
  error: {
    color: COLORS.danger,
    marginTop: 8,
  },
  connectingHint: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 10,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 10,
    alignSelf: "flex-start",
  },
  retryButtonText: {
    color: COLORS.accent,
    fontWeight: "700",
    fontSize: 14,
  },
});

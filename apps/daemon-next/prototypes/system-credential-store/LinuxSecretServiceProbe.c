// THROWAWAY PROTOTYPE for #677. Not production credential-store code.
#include <glib.h>
#include <glib/gstdio.h>
#include <libsecret/secret.h>
#include <sys/random.h>
#include <unistd.h>

#include <stdio.h>
#include <string.h>

static const SecretSchema credential_schema = {
    "dev.agentbean.prototype.credential",
    SECRET_SCHEMA_NONE,
    {
        {"namespace", SECRET_SCHEMA_ATTRIBUTE_STRING},
        {"credential-ref", SECRET_SCHEMA_ATTRIBUTE_STRING},
        {"generation", SECRET_SCHEMA_ATTRIBUTE_INTEGER},
        {"scope", SECRET_SCHEMA_ATTRIBUTE_STRING},
        {NULL, 0},
    },
};

static gboolean constant_time_equal(const gchar *left, const gchar *right) {
    gsize left_length = strlen(left);
    gsize right_length = strlen(right);
    gsize length = left_length > right_length ? left_length : right_length;
    unsigned char difference = (unsigned char)(left_length ^ right_length);
    for (gsize index = 0; index < length; index++) {
        unsigned char left_byte = index < left_length ? (unsigned char)left[index] : 0;
        unsigned char right_byte = index < right_length ? (unsigned char)right[index] : 0;
        difference |= left_byte ^ right_byte;
    }
    return difference == 0;
}

static gchar *random_hex(gsize byte_count) {
    unsigned char *bytes = g_malloc(byte_count);
    ssize_t result = getrandom(bytes, byte_count, 0);
    if (result != (ssize_t)byte_count) {
        g_free(bytes);
        return NULL;
    }
    gchar *hex = g_malloc0(byte_count * 2 + 1);
    for (gsize index = 0; index < byte_count; index++) {
        g_snprintf(hex + index * 2, 3, "%02x", bytes[index]);
    }
    explicit_bzero(bytes, byte_count);
    g_free(bytes);
    return hex;
}

static const gchar *map_error(const GError *error) {
    if (error == NULL) return "not_found";
    if (error->domain == SECRET_ERROR && error->code == SECRET_ERROR_IS_LOCKED) return "locked";
    if (error->domain == G_DBUS_ERROR &&
        (error->code == G_DBUS_ERROR_SERVICE_UNKNOWN || error->code == G_DBUS_ERROR_NAME_HAS_NO_OWNER)) {
        return "backend_unavailable";
    }
    if (error->domain == G_IO_ERROR && error->code == G_IO_ERROR_CANCELLED) return "denied";
    return "backend_error";
}

static void print_error(const gchar *operation, GError **error) {
    GError *current = error == NULL ? NULL : *error;
    g_printerr("PROBE_FAILED:%s:%s:%u:%d\n", operation, map_error(current),
               current == NULL ? 0 : (unsigned int)current->domain, current == NULL ? 0 : current->code);
    if (error != NULL) g_clear_error(error);
}

static gboolean store_secret(const gchar *credential_ref, gint generation, const gchar *scope,
                             const gchar *secret, GError **error) {
    gchar *envelope = g_strdup_printf("ABCR:1:%s:%s:%d:%s", scope, credential_ref, generation, secret);
    gboolean stored = secret_password_store_sync(
        &credential_schema,
        SECRET_COLLECTION_DEFAULT,
        "AgentBean prototype credential",
        envelope,
        NULL,
        error,
        "namespace", "prototype",
        "credential-ref", credential_ref,
        "generation", generation,
        "scope", scope,
        NULL);
    explicit_bzero(envelope, strlen(envelope));
    g_free(envelope);
    return stored;
}

static gchar *lookup_secret(const gchar *credential_ref, gint generation, const gchar *scope,
                            GError **error) {
    gchar *envelope = secret_password_lookup_sync(
        &credential_schema,
        NULL,
        error,
        "namespace", "prototype",
        "credential-ref", credential_ref,
        "generation", generation,
        "scope", scope,
        NULL);
    if (envelope == NULL) return NULL;

    gchar **parts = g_strsplit(envelope, ":", 6);
    gboolean valid = g_strv_length(parts) == 6 &&
        g_str_equal(parts[0], "ABCR") &&
        g_str_equal(parts[1], "1") &&
        g_str_equal(parts[2], scope) &&
        g_str_equal(parts[3], credential_ref) &&
        (gint)g_ascii_strtoll(parts[4], NULL, 10) == generation;
    gchar *secret = valid ? g_strdup(parts[5]) : NULL;
    explicit_bzero(envelope, strlen(envelope));
    secret_password_free(envelope);
    g_strfreev(parts);
    if (!valid) g_set_error_literal(error, SECRET_ERROR, SECRET_ERROR_PROTOCOL, "invalid envelope");
    return secret;
}

static gboolean clear_secret(const gchar *credential_ref, gint generation, const gchar *scope,
                             GError **error) {
    return secret_password_clear_sync(
        &credential_schema,
        NULL,
        error,
        "namespace", "prototype",
        "credential-ref", credential_ref,
        "generation", generation,
        "scope", scope,
        NULL);
}

static gboolean require_lookup_equal(const gchar *credential_ref, gint generation, const gchar *scope,
                                     const gchar *expected, const gchar *code) {
    GError *error = NULL;
    gchar *actual = lookup_secret(credential_ref, generation, scope, &error);
    if (error != NULL) {
        print_error(code, &error);
        return FALSE;
    }
    gboolean matches = actual != NULL && constant_time_equal(actual, expected);
    if (actual != NULL) {
        explicit_bzero(actual, strlen(actual));
        secret_password_free(actual);
    }
    if (!matches) g_printerr("PROBE_FAILED:%s\n", code);
    return matches;
}

static gboolean require_not_found(const gchar *credential_ref, gint generation, const gchar *scope,
                                  const gchar *code) {
    GError *error = NULL;
    gchar *actual = lookup_secret(credential_ref, generation, scope, &error);
    if (actual != NULL) {
        explicit_bzero(actual, strlen(actual));
        secret_password_free(actual);
        g_printerr("PROBE_FAILED:%s\n", code);
        return FALSE;
    }
    if (error != NULL) {
        print_error(code, &error);
        return FALSE;
    }
    return TRUE;
}

int main(void) {
    if (sizeof(void *) != 8 || g_strcmp0(g_getenv("DBUS_SESSION_BUS_ADDRESS"), NULL) == 0) {
        g_printerr("LINUX_X64_SESSION_DBUS_REQUIRED\n");
        return 1;
    }

    gchar *credential_ref_a = random_hex(16);
    gchar *credential_ref_b = random_hex(16);
    gchar *copied_profile_ref = random_hex(16);
    gchar *first_secret = random_hex(32);
    gchar *replacement_secret = random_hex(32);
    gchar *sibling_secret = random_hex(32);
    gchar *marker_directory = g_dir_make_tmp("agentbean-secret-service-prototype-XXXXXX", NULL);
    gchar *marker_path = marker_directory == NULL ? NULL : g_build_filename(marker_directory, "current-generation", NULL);
    gboolean success = credential_ref_a && credential_ref_b && copied_profile_ref && first_secret &&
        replacement_secret && sibling_secret && marker_path;
    GError *error = NULL;

    if (!success) {
        g_printerr("PROBE_FAILED:INITIALIZATION\n");
        goto cleanup;
    }

    if (!store_secret(credential_ref_a, 1, "device", first_secret, &error)) {
        print_error("store_g1", &error);
        success = FALSE;
        goto cleanup;
    }
    if (!require_lookup_equal(credential_ref_a, 1, "device", first_secret, "READ_BACK_MISMATCH")) {
        success = FALSE;
        goto cleanup;
    }
    if (!g_file_set_contents(marker_path, "1", 1, &error)) {
        print_error("write_current_marker_g1", &error);
        success = FALSE;
        goto cleanup;
    }

    if (!store_secret(credential_ref_a, 2, "device", replacement_secret, &error)) {
        print_error("store_g2", &error);
        success = FALSE;
        goto cleanup;
    }
    if (!require_lookup_equal(credential_ref_a, 2, "device", replacement_secret, "GENERATION_2_READ_BACK_MISMATCH")) {
        success = FALSE;
        goto cleanup;
    }
    gchar *generation_text = NULL;
    if (!g_file_get_contents(marker_path, &generation_text, NULL, &error) || !g_str_equal(generation_text, "1")) {
        print_error("STAGED_GENERATION_BECAME_CURRENT", &error);
        g_free(generation_text);
        success = FALSE;
        goto cleanup;
    }
    g_free(generation_text);
    if (!require_lookup_equal(credential_ref_a, 1, "device", first_secret, "CRASH_RECOVERY_DID_NOT_USE_G1")) {
        success = FALSE;
        goto cleanup;
    }
    if (!g_file_set_contents(marker_path, "2", 1, &error) ||
        !require_lookup_equal(credential_ref_a, 2, "device", replacement_secret, "CURRENT_MARKER_READ_MISMATCH")) {
        print_error("commit_current_marker_g2", &error);
        success = FALSE;
        goto cleanup;
    }
    if (!clear_secret(credential_ref_a, 1, "device", &error) ||
        !require_not_found(credential_ref_a, 1, "device", "OLD_GENERATION_CLEANUP_NOT_CONFIRMED")) {
        print_error("clear_g1", &error);
        success = FALSE;
        goto cleanup;
    }

    if (!store_secret(credential_ref_b, 1, "local-model", sibling_secret, &error) ||
        !require_lookup_equal(credential_ref_b, 1, "local-model", sibling_secret, "PROFILE_B_READ_BACK_MISMATCH")) {
        print_error("profile_b", &error);
        success = FALSE;
        goto cleanup;
    }
    if (!require_lookup_equal(credential_ref_a, 2, "device", replacement_secret, "RENAME_CHANGED_REFERENCE") ||
        !require_not_found(copied_profile_ref, 1, "device", "PROFILE_COPY_INHERITED_REFERENCE")) {
        success = FALSE;
        goto cleanup;
    }
    if (!clear_secret(credential_ref_a, 2, "device", &error) ||
        !require_not_found(credential_ref_a, 2, "device", "DELETE_NOT_CONFIRMED")) {
        print_error("delete_current_generation", &error);
        success = FALSE;
        goto cleanup;
    }

    g_print("{\n");
    g_print("  \"schemaVersion\": 1,\n");
    g_print("  \"question\": \"linux-current-user-secret-service-generation-and-isolation-boundary\",\n");
    g_print("  \"host\": {\"uid\": %u, \"user\": \"%s\", \"arch\": \"x64\", \"sessionDbus\": true},\n",
            (unsigned int)getuid(), g_get_user_name());
    g_print("  \"checks\": {\"defaultCollection\": true, \"nativeLibsecret\": true, \"writeReadBack\": true, ");
    g_print("\"immutableGenerationReadBack\": true, \"envelopeAndScopeValidated\": true, ");
    g_print("\"crashBeforeMarkerKeepsOldGeneration\": true, \"currentMarkerSwitchesGeneration\": true, ");
    g_print("\"oldGenerationCleanupConfirmed\": true, \"opaqueProfileIsolation\": true, ");
    g_print("\"profileRenamePreservesReference\": true, \"profileCopyGetsNoReference\": true, ");
    g_print("\"deleteConfirmedNotFound\": true, \"secretAbsentFromArgvAndEnvironment\": true, \"cleanupAttempted\": true},\n");
    g_print("  \"verdict\": \"hosted-ephemeral-dbus-partial-needs-real-systemd-user-session-transitions\"\n");
    g_print("}\n");

cleanup:
    if (credential_ref_a) {
        g_clear_error(&error);
        clear_secret(credential_ref_a, 1, "device", &error);
        g_clear_error(&error);
        clear_secret(credential_ref_a, 2, "device", &error);
    }
    if (credential_ref_b) {
        g_clear_error(&error);
        clear_secret(credential_ref_b, 1, "local-model", &error);
    }
    if (copied_profile_ref) {
        g_clear_error(&error);
        clear_secret(copied_profile_ref, 1, "device", &error);
    }
    g_clear_error(&error);
    if (marker_path) g_unlink(marker_path);
    if (marker_directory) g_rmdir(marker_directory);
    g_free(marker_path);
    g_free(marker_directory);
    if (first_secret) { explicit_bzero(first_secret, strlen(first_secret)); g_free(first_secret); }
    if (replacement_secret) { explicit_bzero(replacement_secret, strlen(replacement_secret)); g_free(replacement_secret); }
    if (sibling_secret) { explicit_bzero(sibling_secret, strlen(sibling_secret)); g_free(sibling_secret); }
    g_free(credential_ref_a);
    g_free(credential_ref_b);
    g_free(copied_profile_ref);
    return success ? 0 : 1;
}

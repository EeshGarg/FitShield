package com.usha.fitshield

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Proves the Android matcher shares semantics with the separated FitShield
 * engine. The fixture (`semantics-fixture.json`) is GENERATED from blocklist.js
 * by tools/generate-android-rules.js, so this asserts the Kotlin [RuleEngine]
 * returns the same block/allow decision the browser engine does — preventing
 * silent divergence.
 *
 * Run on a device/emulator: `./gradlew connectedAndroidTest` (or via build-android).
 */
@RunWith(AndroidJUnit4::class)
class SemanticsParityTest {

    @Test
    fun androidMatcherMatchesEngineFixture() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        // Rules load from the APP package's assets (the generated canonical rules).
        val engine = RuleEngine.fromAssets(instrumentation.targetContext)
        // The fixture ships in the TEST package's assets.
        val text = instrumentation.context.assets.open("semantics-fixture.json")
            .readBytes().toString(Charsets.UTF_8)
        val cases = JSONObject(text).getJSONArray("cases")

        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val host = case.getString("host")
            val expected = case.getBoolean("blocked")
            assertEquals("host=$host", expected, engine.isBlocked(host))
        }
    }
}

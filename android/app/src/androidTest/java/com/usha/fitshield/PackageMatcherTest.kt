package com.usha.fitshield

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Proves the on-device app matcher agrees with the GENERATED dataset. The bundled
 * `android-packages.json` (compiled from the data/android app files and the
 * blocklists by tools/generate-android-packages.js) is the fixture: every package it lists must
 * resolve to the same brand through [PackageBlocklist], and an unlisted package
 * must not match — preventing silent divergence between the pipeline and the app.
 *
 * Run: `./gradlew connectedAndroidTest` (or via tools/build-android.js).
 */
@RunWith(AndroidJUnit4::class)
class PackageMatcherTest {

    @Test
    fun matcherAgreesWithGeneratedDataset() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val matcher = PackageBlocklist.fromAssets(ctx)

        val raw = ctx.assets.open(PackageBlocklist.ASSET_NAME).readBytes().toString(Charsets.UTF_8)
        val packages = JSONObject(raw).getJSONObject("packages")

        assertTrue("dataset should list at least one package", packages.length() > 0)
        assertEquals("matcher size must equal the dataset", packages.length(), matcher.size)

        val keys = packages.keys()
        while (keys.hasNext()) {
            val pkg = keys.next()
            val meta = packages.getJSONObject(pkg)
            val brand = matcher.match(pkg)
            assertNotNull("expected a match for $pkg", brand)
            assertEquals("brandId for $pkg", meta.getString("brandId"), brand!!.brandId)
            assertEquals("displayName for $pkg", meta.getString("displayName"), brand.displayName)
            assertEquals("category for $pkg", meta.getString("category"), brand.category)
        }
    }

    @Test
    fun unlistedPackageDoesNotMatch() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val matcher = PackageBlocklist.fromAssets(ctx)
        assertNull(matcher.match("com.example.definitely.not.a.food.app"))
        assertNull(matcher.match(null))
        assertNull(matcher.match(""))
    }
}

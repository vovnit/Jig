package dev.nitochkin.jig

import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge

/**
 * Root surface for the Jig runtime. The Android host will apply the runtime's ops
 * here: views are created by type and positioned with frames from the JS layout.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val root = FrameLayout(this)
        root.addView(
            TextView(this).apply {
                text = getString(R.string.app_name)
                textSize = 34f
                paint.isFakeBoldText = true
            },
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ),
        )
        setContentView(root)
    }
}
